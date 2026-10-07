import type {
  Consequence,
  ConstraintViolation,
  DecisionRecord,
  EndReason,
  MetricSample,
  Objective,
  ObjectiveResult,
  Outcome,
  SimulationResult,
  SystemState,
} from "../../types/index.ts";
import { MINUTES_PER_MONTH, totalCost } from "../costs/cost.ts";
import { formatMetric } from "../metrics/definitions.ts";
import { round } from "../state/numeric.ts";
import { formatTime } from "../simulation/time.ts";

export interface ResultInput {
  scenarioId: string;
  objectives: readonly Objective[];
  objectiveResults: ObjectiveResult[];
  finalState: SystemState;
  complete: boolean;
  endReason: EndReason;
  samples: readonly MetricSample[];
  decisions: DecisionRecord[];
  consequences: Consequence[];
  violations: ConstraintViolation[];
}

/** Score penalty per constraint violation period. */
const VIOLATION_PENALTY = 5;
/** Error rate above which a peak is called out as a weakness. */
const NOTABLE_ERROR_RATE = 0.05;

/** Builds the structured result. Pure: the same input always gives the same result. */
export function buildResult(input: ResultInput): SimulationResult {
  const { samples, objectiveResults, violations, decisions } = input;

  const totalWeight = input.objectives.reduce((sum, objective) => sum + (objective.weight ?? 1), 0);
  const metWeight = input.objectives.reduce(
    (sum, objective, index) => sum + (objectiveResults[index]?.met ? (objective.weight ?? 1) : 0),
    0,
  );
  const metFraction = totalWeight > 0 ? metWeight / totalWeight : 1;
  const activeViolations = violations.filter((violation) => violation.endedAt === null);

  let outcome: Outcome;
  if (input.endReason === "failCondition") outcome = "failure";
  else if (metFraction === 1 && activeViolations.length === 0) outcome = "success";
  else if (metFraction >= 0.5) outcome = "partial";
  else outcome = "failure";

  const peak = (pick: (sample: MetricSample) => number | undefined) =>
    samples.reduce<{ value: number; time: number }>(
      (best, sample) => {
        const value = pick(sample) ?? 0;
        return value > best.value ? { value, time: sample.time } : best;
      },
      { value: 0, time: 0 },
    );

  let weightedAvailability = 0;
  let spend = 0;
  let elapsed = 0;
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1] as MetricSample;
    const sample = samples[index] as MetricSample;
    const minutes = sample.time - previous.time;
    weightedAvailability += minutes * (sample.metrics.availability ?? 1);
    spend += (previous.monthlyCost * minutes) / MINUTES_PER_MONTH;
    elapsed += minutes;
  }
  const availability = elapsed > 0 ? weightedAvailability / elapsed : (samples[0]?.metrics.availability ?? 1);
  const peakError = peak((sample) => sample.metrics.errorRate);

  const strengths: string[] = [];
  const weaknesses: string[] = [];
  for (const result of objectiveResults) {
    if (result.met) strengths.push(`Objective met: ${result.description}.`);
    else if (result.firstFailedAt !== null) weaknesses.push(`Objective missed: ${result.description} (first missed at ${formatTime(result.firstFailedAt)}).`);
    else weaknesses.push(`Objective missed: ${result.description}.`);
  }
  if (violations.length === 0) strengths.push("No constraints were violated.");
  for (const violation of violations) {
    const period = violation.endedAt === null ? `since ${formatTime(violation.startedAt)}` : `from ${formatTime(violation.startedAt)} to ${formatTime(violation.endedAt)}`;
    weaknesses.push(`Constraint violated ${period}: ${violation.description}.`);
  }
  if (peakError.value > NOTABLE_ERROR_RATE) {
    weaknesses.push(`Error rate peaked at ${formatMetric("errorRate", peakError.value)} at ${formatTime(peakError.time)}.`);
  }
  if (decisions.length === 0) {
    weaknesses.push("No decisions were taken.");
  } else {
    const undocumented = decisions.filter((record) => record.rationale.trim() === "").length;
    if (undocumented === 0) strengths.push("Every decision was recorded with a rationale.");
    else weaknesses.push(`${undocumented} decision${undocumented === 1 ? " was" : "s were"} taken without a rationale.`);
  }

  return {
    scenarioId: input.scenarioId,
    outcome,
    complete: input.complete,
    endReason: input.endReason,
    duration: input.finalState.time,
    finalState: input.finalState,
    metrics: {
      peakLatency: peak((sample) => sample.metrics.latency).value,
      peakP99Latency: peak((sample) => sample.metrics.p99Latency).value,
      peakErrorRate: peakError.value,
      availability: round(availability),
      totalCost: totalCost(input.finalState).monthly,
      spend: round(spend, 2),
      peakQueueDepth: peak((sample) => sample.metrics.queueDepth).value,
      finalComplexity: input.finalState.complexityScore,
    },
    score: Math.max(0, Math.round(metFraction * 100) - VIOLATION_PENALTY * violations.length),
    objectives: objectiveResults,
    decisions,
    consequences: input.consequences,
    constraintsViolated: violations,
    strengths,
    weaknesses,
  };
}
