import type { ComponentType, Dependency, Health } from "./components.ts";
import type { Constraint, ConstraintViolation } from "./constraints.ts";
import type { DecisionRecord, DecisionStatus } from "./decisions.ts";
import type { FiredEvent } from "./events.ts";
import type { MetricSample } from "./history.ts";
import type { EndReason, ObjectiveResult, Outcome, SimulationResult } from "./results.ts";

export interface ArchitectureSnapshot {
  time: number;
  components: {
    id: string;
    type: ComponentType;
    label: string;
    instances: number;
    health: Health;
    utilization: number;
    monthlyCost: number;
  }[];
  dependencies: Dependency[];
  monthlyCost: number;
  complexityScore: number;
}

/** A measurable observation about how the run went. Factual, not an explanation. */
export interface LearningSignal {
  id: string;
  assessment: "strength" | "weakness" | "neutral";
  value: number | boolean | null;
  detail: string;
}

/** Everything a UI needs to render an incident postmortem, as structured data. */
export interface Postmortem {
  scenario: { id: string; title: string };
  summary: {
    outcome: Outcome;
    score: number;
    endReason: EndReason;
    duration: number;
    /** First time a metric constraint (SLO) was violated; `null` if never. */
    incidentStartedAt: number | null;
    stabilizedAt: number | null;
    /** Minutes from the incident starting to stabilization. */
    timeToStabilize: number | null;
  };
  impact: SimulationResult["impact"] & { availability: number; peakLatency: number; peakP99Latency: number; peakErrorRate: number };
  cost: { initialMonthlyCost: number; finalMonthlyCost: number; incidentSpend: number };
  objectives: ObjectiveResult[];
  decisions: DecisionRecord[];
  rejectedDecisions: { time: number; decisionId: string; status: Exclude<DecisionStatus, "valid">; reasons: string[]; rationale: string }[];
  events: FiredEvent[];
  constraints: {
    timeline: { time: number; change: "added" | "updated" | "removed"; constraint: Constraint }[];
    violations: ConstraintViolation[];
  };
  architecture: { initial: ArchitectureSnapshot; final: ArchitectureSnapshot };
  timeline: MetricSample[];
  learningSignals: LearningSignal[];
}
