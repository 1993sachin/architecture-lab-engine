import type { ConstraintViolation } from "./constraints.ts";
import type { DecisionRecord } from "./decisions.ts";
import type { Consequence } from "./history.ts";
import type { SystemState } from "./state.ts";

export type Outcome = "success" | "failure" | "partial";

export type EndReason = "inProgress" | "maxDuration" | "endCondition" | "failCondition";

export interface ObjectiveResult {
  objectiveId: string;
  description: string;
  evaluation: "final" | "throughout";
  met: boolean;
  /** For `throughout` objectives: first time the condition did not hold. */
  firstFailedAt: number | null;
}

export interface SimulationResult {
  scenarioId: string;
  outcome: Outcome;
  complete: boolean;
  endReason: EndReason;
  /** Logical minutes simulated. */
  duration: number;
  finalState: SystemState;
  metrics: {
    peakLatency: number;
    peakP99Latency: number;
    peakErrorRate: number;
    /** Time-weighted availability over the whole run. */
    availability: number;
    /** Monthly infrastructure cost of the final architecture. */
    totalCost: number;
    /** Infrastructure spend accumulated during the simulated period. */
    spend: number;
    peakQueueDepth: number;
    finalComplexity: number;
  };
  /** 0..100, from objective weights minus constraint violation penalties. */
  score: number;
  objectives: ObjectiveResult[];
  decisions: DecisionRecord[];
  consequences: Consequence[];
  constraintsViolated: ConstraintViolation[];
  strengths: string[];
  weaknesses: string[];
}
