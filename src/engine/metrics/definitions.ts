import type { MetricDefinition, MetricId } from "../../types/index.ts";
import { formatUsd } from "../costs/cost.ts";
import { round } from "../state/numeric.ts";

export const METRIC_DEFINITIONS: Readonly<Record<MetricId, MetricDefinition>> = {
  requestsPerSecond: { id: "requestsPerSecond", label: "Request rate", unit: "rps", betterWhen: "neutral", significantChange: 1 },
  latency: { id: "latency", label: "Average latency", unit: "ms", betterWhen: "lower", significantChange: 1 },
  p95Latency: { id: "p95Latency", label: "p95 latency", unit: "ms", betterWhen: "lower", significantChange: 1 },
  p99Latency: { id: "p99Latency", label: "p99 latency", unit: "ms", betterWhen: "lower", significantChange: 1 },
  errorRate: { id: "errorRate", label: "Error rate", unit: "ratio", betterWhen: "lower", significantChange: 0.001 },
  availability: { id: "availability", label: "Availability", unit: "ratio", betterWhen: "higher", significantChange: 0.001 },
  throttleRate: { id: "throttleRate", label: "Throttled requests", unit: "ratio", betterWhen: "lower", significantChange: 0.001 },
  serverErrorRate: { id: "serverErrorRate", label: "Server error rate", unit: "ratio", betterWhen: "lower", significantChange: 0.001 },
  cpuUtilization: { id: "cpuUtilization", label: "Application CPU utilization", unit: "ratio", betterWhen: "lower", significantChange: 0.01 },
  memoryUtilization: { id: "memoryUtilization", label: "Application memory utilization", unit: "ratio", betterWhen: "lower", significantChange: 0.01 },
  databaseUtilization: { id: "databaseUtilization", label: "Database utilization", unit: "ratio", betterWhen: "lower", significantChange: 0.01 },
  cacheHitRate: { id: "cacheHitRate", label: "Cache hit rate", unit: "ratio", betterWhen: "higher", significantChange: 0.01 },
  queueDepth: { id: "queueDepth", label: "Queue depth", unit: "messages", betterWhen: "lower", significantChange: 1 },
  monthlyCost: { id: "monthlyCost", label: "Monthly cost", unit: "usd/month", betterWhen: "lower", significantChange: 1 },
};

/** Human-readable value, e.g. `120 ms`, `2.5%`, `$1,200/month`. */
export function formatMetric(metric: MetricId, value: number): string {
  switch (METRIC_DEFINITIONS[metric].unit) {
    case "ms":
      return `${round(value, 1)} ms`;
    case "ratio":
      return `${round(value * 100, 2)}%`;
    case "rps":
      return `${round(value, 1)} rps`;
    case "messages":
      return `${Math.round(value)} messages`;
    case "usd/month":
      return `${formatUsd(value)}/month`;
  }
}
