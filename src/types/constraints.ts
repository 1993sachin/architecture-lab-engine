import type { Condition } from "./conditions.ts";
import type { MetricId } from "./metrics.ts";

/**
 * `block`: decisions that would introduce or worsen a violation are unavailable.
 * `monitor`: violations are recorded over time but never block decisions.
 */
export type ConstraintEnforcement = "block" | "monitor";

interface ConstraintBase {
  id: string;
  description: string;
  /** Defaults: `block` for budget, complexity and requirement; `monitor` for metric and deadline. */
  enforcement?: ConstraintEnforcement;
}

export type Constraint =
  /** Monthly infrastructure cost must stay at or below `limit` (USD). */
  | (ConstraintBase & { kind: "budget"; limit: number })
  /** Complexity score must stay at or below `limit`; models what the team can operate. */
  | (ConstraintBase & { kind: "complexity"; limit: number })
  /** A metric must stay below (`max`) or above (`min`) `limit`. */
  | (ConstraintBase & { kind: "metric"; metric: MetricId; bound: "max" | "min"; limit: number })
  /** A condition that must hold, e.g. data residency. */
  | (ConstraintBase & { kind: "requirement"; condition: Condition })
  /** `condition` must hold from logical time `limit` onwards. */
  | (ConstraintBase & { kind: "deadline"; limit: number; condition: Condition });

export type ConstraintKind = Constraint["kind"];

export interface ConstraintCheck {
  constraintId: string;
  kind: ConstraintKind;
  satisfied: boolean;
  /** Measured value, when the constraint is numeric. */
  actual?: number;
  limit?: number;
  message: string;
}

/** A period during which a constraint was violated. */
export interface ConstraintViolation {
  constraintId: string;
  kind: ConstraintKind;
  description: string;
  message: string;
  startedAt: number;
  /** `null` while the violation is ongoing. */
  endedAt: number | null;
  limit?: number;
  /** Worst measured value during the violation, when numeric. */
  worstValue?: number;
}
