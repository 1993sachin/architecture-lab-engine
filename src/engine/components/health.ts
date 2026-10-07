import type { Health } from "../../types/index.ts";

export interface HealthProfile {
  /** Multiplier applied to capacity. */
  capacityFactor: number;
  /** Fraction of requests that fail regardless of load. */
  errorRate: number;
  /** Multiplier applied to processing latency. */
  latencyFactor: number;
}

export const HEALTH_PROFILES: Readonly<Record<Health, HealthProfile>> = {
  healthy: { capacityFactor: 1, errorRate: 0, latencyFactor: 1 },
  degraded: { capacityFactor: 0.6, errorRate: 0.01, latencyFactor: 1.5 },
  unhealthy: { capacityFactor: 0.25, errorRate: 0.1, latencyFactor: 3 },
  down: { capacityFactor: 0, errorRate: 1, latencyFactor: 1 },
};
