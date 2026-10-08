/**
 * Metric identifiers the engine knows how to calculate.
 *
 * A scenario may track any subset of them (see `ScenarioDefinition.metrics`);
 * metrics that do not apply to a system (for example `cacheHitRate` when there
 * is no cache) are simply absent from `SystemState.metrics`.
 */
export const METRIC_IDS = [
  "requestsPerSecond",
  "latency",
  "p95Latency",
  "p99Latency",
  "errorRate",
  "availability",
  "throttleRate",
  "serverErrorRate",
  "cpuUtilization",
  "memoryUtilization",
  "databaseUtilization",
  "cacheHitRate",
  "queueDepth",
  "processingRate",
  "processingDelay",
  "workerUtilization",
  "retryRate",
  "jobFailureRate",
  "monthlyCost",
] as const;

export type MetricId = (typeof METRIC_IDS)[number];

/** Metric values. Absent keys mean "not applicable to this system". */
export type Metrics = Partial<Record<MetricId, number>>;

export type MetricUnit = "rps" | "ms" | "s" | "ratio" | "messages" | "usd/month";

export interface MetricDefinition {
  id: MetricId;
  label: string;
  unit: MetricUnit;
  /** Which direction is an improvement. Used to classify consequences. */
  betterWhen: "lower" | "higher" | "neutral";
  /** Absolute change below which a difference is not reported as a consequence. */
  significantChange: number;
}
