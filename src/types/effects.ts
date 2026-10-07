import type { Condition } from "./conditions.ts";
import type { ComponentSpec, ConfigValue, CostInput, DependencySpec, Health, TrafficClass } from "./components.ts";
import type { Constraint, ConstraintEnforcement } from "./constraints.ts";

/** A numeric adjustment, applied in order: set, multiply, add, then clamp to min/max. */
export interface NumericChange {
  set?: number;
  multiply?: number;
  add?: number;
  min?: number;
  max?: number;
}

/** Declarative, serializable state changes used by decisions and events. */
export type Effect =
  | { type: "addComponent"; component: ComponentSpec }
  /** Removes a component and every dependency touching it. */
  | { type: "removeComponent"; componentId: string }
  | {
      type: "updateComponent";
      componentId: string;
      instances?: NumericChange;
      capacity?: NumericChange;
      baseLatencyMs?: NumericChange;
      /** Changes the hourly cost of one instance. */
      costPerInstance?: NumericChange;
    }
  | { type: "setHealth"; componentId: string; health: Health }
  /** Sets a configuration value, or changes a numeric one. */
  | { type: "configure"; componentId: string; key: string; value?: ConfigValue; change?: NumericChange }
  /** Adds a dependency, or replaces the one with the same from/to/traffic. */
  | { type: "connect"; dependency: DependencySpec }
  | { type: "disconnect"; from: string; to: string; traffic?: TrafficClass }
  /**
   * Moves `fraction` of the traffic flowing into `target` over to `to`, for every
   * incoming edge matching `traffic`. This is how a cache or replica is put in
   * front of a component without knowing who calls it.
   */
  | { type: "redirect"; target: string; to: string; traffic: TrafficClass; fraction: number }
  | { type: "workload"; requestsPerSecond?: NumericChange; readRatio?: NumericChange }
  | { type: "complexity"; change: NumericChange }
  /** Adds (or with `null`, removes) a recurring non-component cost. */
  | { type: "additionalCost"; id: string; cost: CostInput | null }
  | { type: "flag"; flag: string; value: ConfigValue }
  | { type: "resource"; resource: string; change: NumericChange }
  | { type: "addConstraint"; constraint: Constraint }
  | { type: "updateConstraint"; constraintId: string; limit?: NumericChange; enforcement?: ConstraintEnforcement }
  | { type: "removeConstraint"; constraintId: string };

/** Effects applied repeatedly while time advances, e.g. a cache warming up. */
export interface OngoingEffect {
  id: string;
  description: string;
  effects: Effect[];
  /** Apply every `interval` minutes after activation. Defaults to 1. */
  interval?: number;
  /** Stop after this many minutes. Defaults to no limit. */
  duration?: number;
  /** Stop as soon as this condition holds (checked before each application). */
  until?: Condition;
}
