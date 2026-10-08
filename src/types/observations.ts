import type { MetricId } from "./metrics.ts";

/** Something the engineer can look at. */
export type Signal =
  | { kind: "metric"; metric: MetricId }
  | { kind: "workload"; property: "requestsPerSecond" | "readRatio" }
  | { kind: "component"; componentId: string; property: "utilization" | "health" | "latencyMs" | "errorRate" | "instances" | "capacity" }
  /** A component setting, e.g. a database's `writeCost`. */
  | { kind: "configuration"; componentId: string; key: string }
  /** A scenario fact held in `SystemState.flags`. */
  | { kind: "flag"; flag: string };

/**
 * A named signal. Scenarios list what can be observed; some signals start
 * hidden and are revealed by investigation decisions. Observations change what
 * the engineer knows, never the system itself.
 */
export interface Observation {
  id: string;
  label: string;
  signal: Signal;
  /** Whether the engineer can see it from the start. Defaults to true. */
  visible?: boolean;
  /** What the observation means, for a reader seeing it for the first time. */
  description?: string;
  /** How to show a numeric configuration or flag value: `ratio` as a percentage, `multiplier` as `1.25×`. */
  format?: "ratio" | "multiplier";
}

/** The value of an observation at one moment. */
export interface ObservedValue {
  id: string;
  label: string;
  /** `null` when the signal does not apply (e.g. the component does not exist). */
  value: number | string | boolean | null;
  /** Readable form, e.g. `Reads are 80% of traffic` or `Primary Database utilization: 146%`. */
  text: string;
  /** The observation's description, when the scenario gives one. */
  description?: string;
}
