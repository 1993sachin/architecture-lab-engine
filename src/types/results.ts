import type { ConstraintViolation } from "./constraints.ts";
import type { DecisionRecord } from "./decisions.ts";
import type { Consequence } from "./history.ts";
import type { ObjectiveEvaluation } from "./scenario.ts";
import type { SystemState } from "./state.ts";

export type Outcome = "success" | "failure" | "partial";

export type EndReason = "inProgress" | "maxDuration" | "endCondition" | "failCondition";

export interface ObjectiveResult {
  objectiveId: string;
  description: string;
  evaluation: ObjectiveEvaluation;
  met: boolean;
  /** Fraction of elapsed time the condition held (for `final`: 1 or 0 at the end). */
  achieved: number;
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
  /** What the incident cost users and how long it lasted. */
  impact: {
    /** Requests that failed, including rejected ones, over the run. */
    failedRequests: number;
    /** Of those, requests deliberately rejected by rate limiting. */
    throttledRequests: number;
    /** Minutes during which at least one constraint was violated. */
    minutesInViolation: number;
    /** Fraction of elapsed time with no constraint violated. */
    compliance: number;
    /**
     * Time from which every metric constraint (SLO) held until the end;
     * `null` if they do not hold at the end.
     */
    stabilizedAt: number | null;
  };
  /** 0..100: 70 × weighted objectives met + 30 × compliance. */
  score: number;
  objectives: ObjectiveResult[];
  decisions: DecisionRecord[];
  consequences: Consequence[];
  constraintsViolated: ConstraintViolation[];
  strengths: string[];
  weaknesses: string[];
}
