import type { DecisionRecord, DecisionStatus } from "./decisions.ts";
import type { FiredEvent } from "./events.ts";
import type { MetricId, Metrics } from "./metrics.ts";

export type ConsequenceSource =
  | { kind: "decision"; decisionId: string }
  /** Time passing: ongoing effects, events and accumulation (e.g. queue backlog). */
  | { kind: "progression"; from: number; to: number; causes: string[] };

export type ConsequenceSubject =
  | { kind: "metric"; metric: MetricId }
  | { kind: "complexity" }
  | { kind: "component"; componentId: string; change: "added" | "removed" | "health" | "instances" };

/** A deterministic description of something that changed. */
export interface Consequence {
  id: string;
  time: number;
  source: ConsequenceSource;
  subject: ConsequenceSubject;
  before: number | string | null;
  after: number | string | null;
  /** Numeric difference, when both sides are numbers. */
  delta: number | null;
  impact: "positive" | "negative" | "neutral";
  severity: "info" | "warning" | "critical";
  description: string;
}

export interface MetricSample {
  time: number;
  metrics: Metrics;
  complexityScore: number;
  /** Always recorded, even when `monthlyCost` is not a tracked metric. */
  monthlyCost: number;
}

/** An action that can be replayed to reproduce a simulation exactly. */
export type SimulationAction =
  | { type: "decide"; decisionId: string; rationale: string }
  | { type: "advance"; minutes: number };

export type HistoryEntry =
  | { type: "decision"; time: number; record: DecisionRecord }
  | { type: "rejectedDecision"; time: number; decisionId: string; status: Exclude<DecisionStatus, "valid">; reasons: string[]; rationale: string }
  | { type: "event"; time: number; event: FiredEvent }
  | { type: "advance"; from: number; to: number; consequences: Consequence[] };

export interface SimulationHistory {
  entries: HistoryEntry[];
  decisions: DecisionRecord[];
  events: FiredEvent[];
  /** One sample at T+0 and one per tick. */
  samples: MetricSample[];
  actions: SimulationAction[];
}
