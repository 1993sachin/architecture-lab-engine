import type {
  BusinessImpactModel,
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
  businessImpact: BusinessImpactModel | null;
}

/** Share of the score from objectives; the rest comes from time spent within constraints. */
const OBJECTIVE_WEIGHT = 70;
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
  let minutesInViolation = 0;
  let sloViolationMinutes = 0;
  const violationMinutes: Record<string, number> = {};
  let totalRequests = 0;
  let failedRequests = 0;
  let throttledRequests = 0;
  const sloIds = new Set(input.finalState.constraints.filter((constraint) => constraint.kind === "metric").map((constraint) => constraint.id));
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1] as MetricSample;
    const sample = samples[index] as MetricSample;
    const minutes = sample.time - previous.time;
    weightedAvailability += minutes * (sample.metrics.availability ?? 1);
    spend += (previous.monthlyCost * minutes) / MINUTES_PER_MONTH;
    if (sample.violations.length > 0) minutesInViolation += minutes;
    if (sample.violations.some((id) => sloIds.has(id))) sloViolationMinutes += minutes;
    for (const id of sample.violations) violationMinutes[id] = (violationMinutes[id] ?? 0) + minutes;
    totalRequests += sample.requests;
    failedRequests += sample.failedRequests;
    throttledRequests += sample.throttledRequests;
    elapsed += minutes;
  }
  const compliance = elapsed > 0 ? 1 - minutesInViolation / elapsed : (samples[0]?.violations.length ?? 0) === 0 ? 1 : 0;

  // Stabilized: from this sample on, every metric constraint (SLO) held.
  let stabilizedAt: number | null = null;
  for (let index = samples.length - 1; index >= 0; index--) {
    const sample = samples[index] as MetricSample;
    if (sample.violations.some((id) => sloIds.has(id))) break;
    stabilizedAt = sample.time;
  }
  const availability = elapsed > 0 ? weightedAvailability / elapsed : (samples[0]?.metrics.availability ?? 1);
  const peakError = peak((sample) => sample.metrics.errorRate);

  const strengths: string[] = [];
  const weaknesses: string[] = [];
  for (const result of objectiveResults) {
    if (result.met) strengths.push(`Objective met: ${result.description}.`);
    else if (result.evaluation === "fractionOfTime") {
      const required = input.objectives.find((objective) => objective.id === result.objectiveId)?.threshold ?? 1;
      weaknesses.push(`Objective missed: ${result.description} (held ${round(result.achieved * 100, 1)}% of the time; needed ${round(required * 100, 1)}%).`);
    } else if (result.firstFailedAt !== null) weaknesses.push(`Objective missed: ${result.description} (first missed at ${formatTime(result.firstFailedAt)}).`);
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
    impact: {
      totalRequests: Math.round(totalRequests),
      successfulRequests: Math.round(totalRequests - failedRequests - throttledRequests),
      failedRequests: Math.round(failedRequests),
      throttledRequests: Math.round(throttledRequests),
      businessImpact: input.businessImpact
        ? round(failedRequests * input.businessImpact.valuePerFailedRequest + throttledRequests * input.businessImpact.valuePerThrottledRequest, 2)
        : null,
      minutesInViolation,
      sloViolationMinutes,
      violationMinutes,
      compliance: round(compliance),
      stabilizedAt,
    },
    score: Math.round(OBJECTIVE_WEIGHT * metFraction + (100 - OBJECTIVE_WEIGHT) * compliance),
    objectives: objectiveResults,
    decisions,
    consequences: input.consequences,
    constraintsViolated: violations,
    strengths,
    weaknesses,
  };
}
