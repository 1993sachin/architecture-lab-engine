export const COMPONENT_TYPES = [
  "client",
  "apiGateway",
  "loadBalancer",
  "application",
  "cache",
  "database",
  "databaseReplica",
  "queue",
  "objectStorage",
  "cdn",
  "worker",
] as const;

export type ComponentType = (typeof COMPONENT_TYPES)[number];

export type Health = "healthy" | "degraded" | "unhealthy" | "down";

/** Approximate infrastructure cost. Not real cloud pricing, but internally consistent. */
export interface Cost {
  hourly: number;
  monthly: number;
}

/** A cost given as either an hourly or a monthly amount; the other is derived. */
export type CostInput = { hourly: number } | { monthly: number };

export type ConfigValue = number | string | boolean;

/** Which requests travel along a dependency edge. */
export type TrafficClass = "all" | "read" | "write";

/** Per-component results of the last metric calculation. */
export interface ComponentLoad {
  /** Requests per second arriving at the component. */
  inbound: number;
  /** Requests per second rejected by rate limiting before being processed. */
  throttled: number;
  /** Requests per second the component tried to process (inbound minus throttled). */
  accepted: number;
  /** Requests per second processed successfully. */
  served: number;
  /** Requests per second forwarded to dependencies. */
  outbound: number;
  /**
   * Queues only: messages per second that consumers failed and that go back on
   * the queue for another attempt (see the queue's `maxAttempts` setting).
   */
  retried: number;
  /** Latency added by this component alone, in milliseconds. */
  ownLatencyMs: number;
  /** Fraction of inbound requests this component fails on its own (including throttling). */
  ownErrorRate: number;
  /** Latency of a request entering here, including synchronous dependencies. */
  latencyMs: number;
  /** Error rate of a request entering here, including synchronous dependencies. */
  errorRate: number;
}

export interface Component {
  id: string;
  type: ComponentType;
  label: string;
  /** Requests per second one instance can handle when healthy. `null` means unbounded. */
  capacity: number | null;
  instances: number;
  /** Processing latency of one request at low utilization, in milliseconds. */
  baseLatencyMs: number;
  health: Health;
  /** Cost of one instance. */
  cost: Cost;
  /** Type-specific settings, e.g. `hitRate` for caches or `rateLimit` for gateways. */
  configuration: Record<string, ConfigValue>;
  /** Demand divided by effective capacity. Values above 1 mean overload. Calculated. */
  utilization: number;
  /** Messages waiting to be processed (queues only). Carried over between ticks. */
  backlog: number;
  /** Calculated flow results. */
  load: ComponentLoad;
}

/** Declarative description of a component. Missing fields come from the component catalog. */
export interface ComponentSpec {
  id: string;
  type: ComponentType;
  label?: string;
  capacity?: number | null;
  instances?: number;
  baseLatencyMs?: number;
  health?: Health;
  cost?: CostInput;
  configuration?: Record<string, ConfigValue>;
}

/** A directed dependency: `from` sends a share of its traffic to `to`. */
export interface Dependency {
  from: string;
  to: string;
  traffic: TrafficClass;
  /** Fraction (0..1) of the matching traffic sent along this edge. */
  share: number;
}

export interface DependencySpec {
  from: string;
  to: string;
  traffic?: TrafficClass;
  share?: number;
}
