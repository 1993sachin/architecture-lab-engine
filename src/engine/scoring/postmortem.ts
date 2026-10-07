import type {
  ArchitectureSnapshot,
  LearningSignal,
  Postmortem,
  Scenario,
  SimulationHistory,
  SimulationResult,
  SystemState,
} from "../../types/index.ts";
import { componentCost, totalCost } from "../costs/cost.ts";
import { formatTime } from "../simulation/time.ts";
import { round } from "../state/numeric.ts";

/** Utilization below which a scaled-out component counts as over-provisioned at the end. */
const IDLE_UTILIZATION = 0.3;

export function architectureSnapshot(state: SystemState): ArchitectureSnapshot {
  return {
    time: state.time,
    components: state.components.map((component) => ({
      id: component.id,
      type: component.type,
      label: component.label,
      instances: component.instances,
      health: component.health,
      utilization: component.utilization,
      monthlyCost: componentCost(component).monthly,
    })),
    dependencies: structuredClone(state.dependencies),
    monthlyCost: totalCost(state).monthly,
    complexityScore: state.complexityScore,
  };
}

/**
 * Assembles a postmortem from a finished (or in-progress) run. Pure: derived
 * entirely from the scenario, the result and the history.
 */
export function createPostmortem(scenario: Scenario, result: SimulationResult, history: SimulationHistory): Postmortem {
  const sloIds = new Set(
    [scenario.initialState, result.finalState].flatMap((state) => state.constraints).filter((c) => c.kind === "metric").map((c) => c.id),
  );
  const incidentStartedAt = history.samples.find((sample) => sample.violations.some((id) => sloIds.has(id)))?.time ?? null;
  const { stabilizedAt } = result.impact;
  const timeToStabilize = incidentStartedAt !== null && stabilizedAt !== null && stabilizedAt >= incidentStartedAt ? stabilizedAt - incidentStartedAt : null;

  const rejectedDecisions = history.entries.flatMap((entry) =>
    entry.type === "rejectedDecision"
      ? [{ time: entry.time, decisionId: entry.decisionId, status: entry.status, reasons: entry.reasons, rationale: entry.rationale }]
      : [],
  );
  const timeline = history.entries.flatMap((entry) =>
    entry.type === "constraint" ? [{ time: entry.time, change: entry.change, constraint: entry.constraint }] : [],
  );

  return {
    scenario: { id: scenario.id, title: scenario.title },
    summary: {
      outcome: result.outcome,
      score: result.score,
      endReason: result.endReason,
      duration: result.duration,
      incidentStartedAt,
      stabilizedAt,
      timeToStabilize,
    },
    impact: {
      ...result.impact,
      availability: result.metrics.availability,
      peakLatency: result.metrics.peakLatency,
      peakP99Latency: result.metrics.peakP99Latency,
      peakErrorRate: result.metrics.peakErrorRate,
    },
    cost: {
      initialMonthlyCost: totalCost(scenario.initialState).monthly,
      finalMonthlyCost: result.metrics.totalCost,
      incidentSpend: result.metrics.spend,
    },
    objectives: result.objectives,
    decisions: result.decisions,
    rejectedDecisions,
    events: history.events,
    constraints: { timeline, violations: result.constraintsViolated },
    architecture: { initial: architectureSnapshot(scenario.initialState), final: architectureSnapshot(result.finalState) },
    timeline: history.samples,
    learningSignals: learningSignals(scenario, result, incidentStartedAt, rejectedDecisions.length),
  };
}

function learningSignals(
  scenario: Scenario,
  result: SimulationResult,
  incidentStartedAt: number | null,
  rejected: number,
): LearningSignal[] {
  const signals: LearningSignal[] = [];
  const decisions = result.decisions;
  const changesSystem = (record: (typeof decisions)[number]) => record.complexityImpact !== 0 || record.costImpact.monthly !== 0 || record.consequences.length > 0;
  const investigations = decisions.filter((record) => record.revealed.length > 0);
  const firstChange = decisions.find(changesSystem);

  if (incidentStartedAt !== null) {
    const firstResponse = decisions.find((record) => record.timestamp >= incidentStartedAt) ?? null;
    const delay = firstResponse ? firstResponse.timestamp - incidentStartedAt : null;
    signals.push({
      id: "time-to-first-response",
      assessment: delay === null ? "weakness" : delay <= 1 ? "strength" : delay >= 5 ? "weakness" : "neutral",
      value: delay,
      detail: delay === null ? "No decision after the incident started." : `First decision ${delay} min after the SLO was first breached (${formatTime(incidentStartedAt)}).`,
    });
  }

  const hidden = scenario.observations.filter((observation) => observation.visible === false).map((observation) => observation.id);
  if (hidden.length > 0) {
    const informedBeforeActing = investigations.length > 0 && firstChange !== undefined && investigations[0]!.sequence < firstChange.sequence;
    signals.push({
      id: "investigated-before-acting",
      assessment: "neutral",
      value: informedBeforeActing,
      detail: informedBeforeActing ? "Investigated before the first change to the system." : "Changed the system before investigating.",
    });
    const blind = decisions.filter((record) => changesSystem(record) && hidden.some((id) => !record.knowledge.some((value) => value.id === id))).length;
    signals.push({
      id: "decisions-with-hidden-information",
      assessment: "neutral",
      value: blind,
      detail: `${blind} of ${decisions.filter(changesSystem).length} system changes were made while some information was still hidden.`,
    });
  }

  const { stabilizedAt, sloViolationMinutes, throttledRequests, totalRequests } = result.impact;
  signals.push({
    id: "stabilized",
    assessment: stabilizedAt === null ? "weakness" : "strength",
    value: stabilizedAt,
    detail: stabilizedAt === null ? "SLOs were not met at the end." : `SLOs held from ${formatTime(stabilizedAt)} to the end.`,
  });
  const sloShare = result.duration > 0 ? sloViolationMinutes / result.duration : 0;
  signals.push({
    id: "slo-violation-share",
    assessment: sloShare <= 0.25 ? "strength" : sloShare >= 0.5 ? "weakness" : "neutral",
    value: round(sloShare),
    detail: `SLOs were violated for ${sloViolationMinutes} of ${result.duration} minutes.`,
  });
  const throttledShare = totalRequests > 0 ? throttledRequests / totalRequests : 0;
  signals.push({
    id: "throttled-share",
    assessment: throttledShare >= 0.1 ? "weakness" : "neutral",
    value: round(throttledShare),
    detail: `${round(throttledShare * 100, 1)}% of requests were rejected by rate limiting.`,
  });
  signals.push({
    id: "blocked-attempts",
    assessment: rejected > 0 ? "weakness" : "neutral",
    value: rejected,
    detail: `${rejected} attempted decision${rejected === 1 ? " was" : "s were"} rejected as invalid or unavailable.`,
  });

  const budgetBreach = result.constraintsViolated.find((violation) => violation.kind === "budget" && violation.endedAt === null);
  if (result.finalState.constraints.some((constraint) => constraint.kind === "budget")) {
    signals.push({
      id: "within-budget-at-end",
      assessment: budgetBreach ? "weakness" : "strength",
      value: !budgetBreach,
      detail: budgetBreach ? `Over budget since ${formatTime(budgetBreach.startedAt)}.` : "Finished within budget.",
    });
  }

  const idle = result.finalState.components.filter(
    (component) => component.type !== "client" && component.instances > 1 && component.capacity !== null && component.utilization < IDLE_UTILIZATION,
  );
  signals.push({
    id: "idle-capacity-at-end",
    assessment: idle.length > 0 ? "weakness" : "neutral",
    value: idle.length,
    detail: idle.length > 0 ? `Over-provisioned at the end: ${idle.map((component) => `${component.label} (${round(component.utilization * 100, 1)}%)`).join(", ")}.` : "No component was left mostly idle.",
  });

  const backlog = result.finalState.metrics.queueDepth;
  if (backlog !== undefined) {
    signals.push({
      id: "queue-backlog-at-end",
      assessment: backlog > 0 ? "weakness" : "neutral",
      value: backlog,
      detail: backlog > 0 ? `${Math.round(backlog).toLocaleString("en-US")} queued messages were still waiting to be processed at the end.` : "Every queued message was processed.",
    });
  }

  const complexityLimit = result.finalState.constraints.find((constraint) => constraint.kind === "complexity");
  const added = round(result.finalState.complexityScore - scenario.initialState.complexityScore, 2);
  signals.push({
    id: "complexity-added",
    assessment: complexityLimit && "limit" in complexityLimit && result.finalState.complexityScore >= 0.8 * complexityLimit.limit ? "weakness" : "neutral",
    value: added,
    detail: `Complexity went from ${scenario.initialState.complexityScore} to ${result.finalState.complexityScore}.`,
  });

  const undocumented = decisions.filter((record) => record.rationale.trim() === "").length;
  signals.push({
    id: "rationale-coverage",
    assessment: decisions.length > 0 && undocumented === 0 ? "strength" : undocumented > 0 ? "weakness" : "neutral",
    value: decisions.length > 0 ? round((decisions.length - undocumented) / decisions.length) : null,
    detail: `${decisions.length - undocumented} of ${decisions.length} decisions recorded a rationale.`,
  });

  return signals;
}
