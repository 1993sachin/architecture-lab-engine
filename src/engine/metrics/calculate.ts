import type { Metrics, MetricId, SystemState } from "../../types/index.ts";
import { effectiveHitRate } from "../components/catalog.ts";
import { effectiveCapacity } from "../components/factory.ts";
import { totalCost } from "../costs/cost.ts";
import { cloneState } from "../state/clone.ts";
import { clamp, round } from "../state/numeric.ts";
import { calculateFlows, entryComponents } from "./flow.ts";

/** Tail latency multipliers grow with the busiest component on the request path. */
function tailFactors(maxUtilization: number): { p95: number; p99: number } {
  const u = Math.min(maxUtilization, 2);
  return { p95: 1.4 + 0.8 * u, p99: 1.8 + 1.6 * u };
}

/**
 * Recalculates flows and metrics in place. `tracked` limits which metrics are
 * reported; `null` reports every applicable metric.
 */
export function calculateMetricsInPlace(state: SystemState, tracked: readonly MetricId[] | null): void {
  const synchronous = calculateFlows(state);
  const metrics: Metrics = {};

  metrics.requestsPerSecond = round(state.workload.requestsPerSecond, 2);

  const entries = entryComponents(state);
  if (entries.length > 0) {
    const totalInbound = entries.reduce((sum, entry) => sum + entry.load.inbound, 0);
    const weight = (inbound: number) => (totalInbound > 0 ? inbound / totalInbound : 1 / entries.length);
    const latency = entries.reduce((sum, entry) => sum + weight(entry.load.inbound) * entry.load.latencyMs, 0);
    const errorRate = clamp(entries.reduce((sum, entry) => sum + weight(entry.load.inbound) * entry.load.errorRate, 0), 0, 1);
    const busiest = state.components
      .filter((component) => component.type !== "client" && synchronous.has(component.id))
      .reduce((max, component) => Math.max(max, component.utilization), 0);
    const tail = tailFactors(busiest);
    metrics.latency = round(latency, 2);
    metrics.p95Latency = round(latency * tail.p95, 2);
    metrics.p99Latency = round(latency * tail.p99, 2);
    metrics.errorRate = round(errorRate);
    metrics.availability = round(1 - errorRate);
    // Error rate counts rate-limited requests as failures (users see them); these split it.
    const rps = state.workload.requestsPerSecond;
    const throttled = state.components.reduce((sum, component) => sum + component.load.throttled, 0);
    const throttleRate = rps > 0 ? clamp(throttled / rps, 0, errorRate) : 0;
    metrics.throttleRate = round(throttleRate);
    metrics.serverErrorRate = round(Math.max(0, errorRate - throttleRate));
  }

  const applications = state.components.filter((component) => component.type === "application");
  if (applications.length > 0) {
    let accepted = 0;
    let capacity = 0;
    let memory = 0;
    let instances = 0;
    for (const application of applications) {
      const appCapacity = effectiveCapacity(application);
      if (appCapacity !== null) {
        accepted += application.load.accepted;
        capacity += appCapacity;
      }
      const baseline = application.configuration["memoryBaseline"];
      const memoryUse = (typeof baseline === "number" ? baseline : 0.3) + 0.5 * Math.min(application.utilization, 1.2);
      memory += clamp(memoryUse, 0, 1) * application.instances;
      instances += application.instances;
    }
    metrics.cpuUtilization = round(capacity > 0 ? accepted / capacity : 0);
    metrics.memoryUtilization = round(instances > 0 ? memory / instances : 0);
  }

  const databases = state.components.filter((component) => component.type === "database" || component.type === "databaseReplica");
  if (databases.length > 0) {
    metrics.databaseUtilization = round(Math.max(...databases.map((database) => database.utilization)));
  }

  const caches = state.components.filter((component) => component.type === "cache");
  if (caches.length > 0) {
    const reads = caches.reduce((sum, cache) => sum + cache.load.accepted, 0);
    metrics.cacheHitRate = round(
      reads > 0
        ? caches.reduce((sum, cache) => sum + cache.load.accepted * effectiveHitRate(cache), 0) / reads
        : caches.reduce((sum, cache) => sum + effectiveHitRate(cache), 0) / caches.length,
    );
  }

  const queues = state.components.filter((component) => component.type === "queue");
  if (queues.length > 0) {
    metrics.queueDepth = round(queues.reduce((sum, queue) => sum + queue.backlog, 0), 2);
  }

  metrics.monthlyCost = totalCost(state).monthly;

  if (tracked !== null) {
    for (const key of Object.keys(metrics) as MetricId[]) {
      if (!tracked.includes(key)) delete metrics[key];
    }
  }
  state.metrics = metrics;
}

/** Returns a copy of the state with flows and metrics recalculated. */
export function calculateMetrics(state: SystemState, tracked: readonly MetricId[] | null = null): SystemState {
  const next = cloneState(state);
  calculateMetricsInPlace(next, tracked);
  return next;
}
