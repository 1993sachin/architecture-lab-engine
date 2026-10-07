import type { Cost, CostInput } from "./components.ts";
import type { Condition } from "./conditions.ts";
import type { Effect, OngoingEffect } from "./effects.ts";
import type { ObservedValue } from "./observations.ts";
import type { Consequence } from "./history.ts";
import type { SystemState } from "./state.ts";

export interface Prerequisite {
  condition: Condition;
  /** Shown when the prerequisite is not met. Generated from the condition if omitted. */
  message?: string;
}

/** A conditional consequence of a decision, evaluated against the state right after its immediate effects. */
export interface SideEffect {
  id: string;
  description: string;
  /** Applies only when this holds. Always applies when omitted. */
  when?: Condition;
  effects: Effect[];
}

export interface DecisionDefinition {
  id: string;
  title: string;
  description: string;
  prerequisites?: Prerequisite[];
  immediateEffects: Effect[];
  ongoingEffects?: OngoingEffect[];
  /**
   * Recurring cost this decision adds beyond the components it creates or resizes
   * (licences, managed-service fees, support). Component costs are derived from
   * the components themselves; use `previewDecision` for the full cost impact.
   */
  costImpact?: CostInput;
  /** Change to the architecture's complexity score. */
  complexityImpact: number;
  sideEffects?: SideEffect[];
  /** Resources consumed, e.g. `{ engineerDays: 3 }`. */
  requires?: Record<string, number>;
  /** Whether the decision can be taken more than once. Defaults to false. */
  repeatable?: boolean;
  /** Observation ids this decision makes visible (investigation). */
  reveals?: string[];
  /**
   * Logical minutes the team spends on it. The simulation advances by this much
   * right after the decision is applied, so the world moves on meanwhile.
   */
  duration?: number;
}

export interface DecisionPreview {
  decisionId: string;
  projectedState: SystemState;
  costDelta: Cost;
  complexityDelta: number;
  sideEffects: string[];
  consequences: Consequence[];
}

export type DecisionValidation =
  | { status: "valid"; decisionId: string; preview: DecisionPreview }
  /** The decision cannot apply in this situation (unknown, already taken, prerequisites unmet). */
  | { status: "invalid"; decisionId: string; reason: string; reasons: string[] }
  /** The decision is possible in principle, but resources or constraints prevent it. */
  | { status: "unavailable"; decisionId: string; reason: string; reasons: string[]; preview?: DecisionPreview };

export type DecisionStatus = DecisionValidation["status"];

export interface DecisionRecord {
  /** 1-based position in the decision sequence. */
  sequence: number;
  decisionId: string;
  title: string;
  /** Logical time (minutes) when the decision was taken. */
  timestamp: number;
  rationale: string;
  /** What the engineer could observe when deciding. */
  knowledge: ObservedValue[];
  /** What the decision revealed, valued right after it was applied. */
  revealed: ObservedValue[];
  stateBefore: SystemState;
  stateAfter: SystemState;
  /** Change in recurring monthly cost caused by the decision. */
  costImpact: Cost;
  /** Change in complexity score caused by the decision. */
  complexityImpact: number;
  consequences: Consequence[];
  sideEffects: string[];
}

export type DecisionOutcome =
  | { status: "applied"; record: DecisionRecord }
  | { status: "invalid" | "unavailable"; decisionId: string; reason: string; reasons: string[] };

/** A decision together with whether it can be taken right now. */
export interface DecisionOption {
  decision: DecisionDefinition;
  validation: DecisionValidation;
}
