import type { Component, ConfigValue, Cost, Dependency } from "./components.ts";
import type { Constraint } from "./constraints.ts";
import type { Metrics } from "./metrics.ts";

export interface Workload {
  /** Offered load at the clients, in requests per second. */
  requestsPerSecond: number;
  /** Fraction (0..1) of requests that are reads. */
  readRatio: number;
}

/**
 * The complete, plain-data state of a simulated system at one logical moment.
 * Everything here is deterministic and serializable.
 */
export interface SystemState {
  /** Logical time in minutes since the scenario started. */
  time: number;
  workload: Workload;
  components: Component[];
  dependencies: Dependency[];
  /** Recurring costs that are not components, e.g. licences or support plans. */
  additionalCosts: Record<string, Cost>;
  complexityScore: number;
  /** Named pools consumed by decisions, e.g. `engineerDays`. */
  resources: Record<string, number>;
  /** Scenario-defined facts, e.g. `dataRegion: "eu"`. */
  flags: Record<string, ConfigValue>;
  /** Active constraints. They can change as the scenario evolves. */
  constraints: Constraint[];
  metrics: Metrics;
}
