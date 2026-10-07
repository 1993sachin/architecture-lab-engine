import type { Component, Dependency, SystemState } from "../../types/index.ts";
import { COMPONENT_CATALOG } from "../components/catalog.ts";
import { effectiveCapacity } from "../components/factory.ts";
import { topologicalOrder } from "../components/graph.ts";
import { HEALTH_PROFILES } from "../components/health.ts";
import { EffectError } from "../errors.ts";
import { round } from "../state/numeric.ts";

/**
 * The flow model.
 *
 * Forward pass (callers before callees): push read and write traffic from the
 * clients through the dependency graph. Each component throttles (rate limit),
 * fails a fraction of what it accepts (health and overload), and forwards what
 * it served to its dependencies according to edge shares and its behaviour
 * (caches forward only misses, queues forward at the rate workers can drain).
 *
 * Backward pass (callees before callers): a request's latency and error rate at
 * a component are its own plus those of the synchronous dependencies it calls,
 * weighted by how often it calls them. This is how a slow or failing database
 * propagates up to the application and the clients.
 */

const DEFAULT_TIMEOUT_MS = 1000;
/**
 * Extra failure fraction per unit of overload. Overloaded systems fail more than
 * their excess (timeouts, retries, thrashing), which is why shedding load early helps.
 */
const OVERLOAD_COLLAPSE = 0.3;

interface Flow {
  read: number;
  write: number;
}

/** Latency multiplier from queueing as utilization rises (smooth, steep near saturation). */
export function queueingFactor(utilization: number): number {
  if (utilization <= 0) return 1;
  if (utilization < 0.95) return 1 + (0.5 * utilization * utilization) / (1 - utilization);
  return 1 + (0.5 * 0.95 * 0.95) / 0.05 + 20 * (utilization - 0.95);
}

/** Fraction of accepted requests failed because demand exceeds capacity. */
export function overloadErrorRate(utilization: number): number {
  if (utilization <= 1) return 0;
  return Math.min(1, 1 - 1 / utilization + OVERLOAD_COLLAPSE * (utilization - 1));
}

function numberConfig(component: Component, key: string, fallback: number): number {
  const value = component.configuration[key];
  return typeof value === "number" ? value : fallback;
}

/** Fraction of a component's requests that travel along an edge, given its read/write mix. */
function edgeFraction(component: Component, dependency: Dependency, readMix: number): number {
  const behavior = COMPONENT_CATALOG[component.type].behavior;
  const reads = dependency.traffic === "write" ? 0 : readMix * behavior.readPassThrough(component) * dependency.share;
  const writes = dependency.traffic === "read" ? 0 : (1 - readMix) * behavior.writePassThrough(component) * dependency.share;
  return reads + writes;
}

/** Components that receive the workload: clients nobody calls. */
export function entryComponents(state: SystemState): Component[] {
  return state.components.filter(
    (component) => component.type === "client" && !state.dependencies.some((dependency) => dependency.to === component.id),
  );
}

/**
 * Recalculates every component's load, utilization, latency and error rate in place.
 * Returns the ids of components on the synchronous request path.
 */
export function calculateFlows(state: SystemState): Set<string> {
  const order = topologicalOrder(state.components, state.dependencies);
  if (order === null) throw new EffectError("Dependencies contain a cycle.");

  const inflow = new Map<string, Flow>();
  const readMix = new Map<string, number>();
  const synchronous = new Set<string>();
  const entries = entryComponents(state);
  for (const entry of entries) {
    const rps = state.workload.requestsPerSecond / entries.length;
    inflow.set(entry.id, { read: rps * state.workload.readRatio, write: rps * (1 - state.workload.readRatio) });
    synchronous.add(entry.id);
  }

  for (const component of order) {
    const flow = inflow.get(component.id) ?? { read: 0, write: 0 };
    const behavior = COMPONENT_CATALOG[component.type].behavior;
    const profile = HEALTH_PROFILES[component.health];
    const inbound = flow.read + flow.write;
    const mix = inbound > 0 ? flow.read / inbound : state.workload.readRatio;
    readMix.set(component.id, mix);

    const rateLimit = numberConfig(component, "rateLimit", 0);
    const accepted = rateLimit > 0 ? Math.min(inbound, rateLimit) : inbound;
    const throttled = inbound - accepted;
    const acceptedFraction = inbound > 0 ? accepted / inbound : 1;

    const capacity = effectiveCapacity(component);
    const noCapacity = capacity === 0;
    const utilization = capacity === null || capacity === 0 ? 0 : accepted / capacity;
    const loadErrorRate = noCapacity ? 1 : overloadErrorRate(utilization);
    // A full queue can only take in what its consumers release; the rest is rejected.
    let overflowRate = 0;
    const maxDepth = numberConfig(component, "maxDepth", 0);
    if (behavior.asynchronous && maxDepth > 0 && component.backlog >= maxDepth && accepted > 0) {
      overflowRate = Math.max(0, 1 - drainCapacity(state, component) / accepted);
    }
    const processErrorRate = 1 - (1 - profile.errorRate) * (1 - loadErrorRate) * (1 - overflowRate);
    const servedRead = flow.read * acceptedFraction * (1 - processErrorRate);
    const servedWrite = flow.write * acceptedFraction * (1 - processErrorRate);
    const served = servedRead + servedWrite;

    const timeout = numberConfig(component, "timeoutMs", DEFAULT_TIMEOUT_MS);
    const ownLatencyMs = noCapacity
      ? timeout
      : Math.min(timeout, component.baseLatencyMs * profile.latencyFactor * queueingFactor(utilization));

    let forwardRead = servedRead * behavior.readPassThrough(component);
    let forwardWrite = servedWrite * behavior.writePassThrough(component);
    if (behavior.asynchronous) {
      // A queue releases work as fast as its consumers can take it, draining any backlog.
      const consumerCapacity = drainCapacity(state, component);
      const available = forwardRead + forwardWrite + component.backlog / 60;
      const released = Math.min(available, consumerCapacity);
      const readShare = forwardRead + forwardWrite > 0 ? forwardRead / (forwardRead + forwardWrite) : 0;
      forwardRead = released * readShare;
      forwardWrite = released * (1 - readShare);
    }

    for (const dependency of state.dependencies) {
      if (dependency.from !== component.id) continue;
      const target = inflow.get(dependency.to) ?? { read: 0, write: 0 };
      if (dependency.traffic !== "write") target.read += forwardRead * dependency.share;
      if (dependency.traffic !== "read") target.write += forwardWrite * dependency.share;
      inflow.set(dependency.to, target);
      if (synchronous.has(component.id) && !behavior.asynchronous) synchronous.add(dependency.to);
    }

    component.utilization = round(utilization);
    component.load = {
      inbound: round(inbound),
      throttled: round(throttled),
      accepted: round(accepted),
      served: round(served),
      outbound: round(forwardRead + forwardWrite),
      ownLatencyMs: round(ownLatencyMs),
      ownErrorRate: round(inbound > 0 ? (throttled + accepted * processErrorRate) / inbound : processErrorRate),
      latencyMs: 0,
      errorRate: 0,
    };
  }

  const latency = new Map<string, number>();
  const errors = new Map<string, number>();
  for (const component of [...order].reverse()) {
    const behavior = COMPONENT_CATALOG[component.type].behavior;
    const own = component.load;
    let latencyMs = own.ownLatencyMs;
    let errorRate = own.ownErrorRate;
    if (!behavior.asynchronous && effectiveCapacity(component) !== 0) {
      let dependencyLatency = 0;
      let dependencyErrors = 0;
      for (const dependency of state.dependencies) {
        if (dependency.from !== component.id) continue;
        const fraction = edgeFraction(component, dependency, readMix.get(component.id) ?? 0);
        dependencyLatency += fraction * (latency.get(dependency.to) ?? 0);
        dependencyErrors += fraction * (errors.get(dependency.to) ?? 0);
      }
      latencyMs += dependencyLatency;
      errorRate = 1 - (1 - errorRate) * (1 - Math.min(1, dependencyErrors));
    }
    latency.set(component.id, latencyMs);
    errors.set(component.id, errorRate);
    component.load.latencyMs = round(latencyMs);
    component.load.errorRate = round(errorRate);
  }

  return synchronous;
}

/** Total capacity of a queue's consumers; unbounded consumers drain everything. */
function drainCapacity(state: SystemState, queue: Component): number {
  let total = 0;
  for (const dependency of state.dependencies) {
    if (dependency.from !== queue.id) continue;
    const consumer = state.components.find((component) => component.id === dependency.to);
    if (!consumer) continue;
    const capacity = effectiveCapacity(consumer);
    if (capacity === null) return Number.POSITIVE_INFINITY;
    total += capacity * dependency.share;
  }
  return total;
}
