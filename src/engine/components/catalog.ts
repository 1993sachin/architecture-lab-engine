import type { Component, ComponentType, ConfigValue } from "../../types/index.ts";
import { clamp } from "../state/numeric.ts";
import { HEALTH_PROFILES } from "./health.ts";

/**
 * How a component type behaves in the flow model.
 *
 * Behaviour is data plus two small functions, so new component types can be
 * added without touching the metric calculation.
 */
export interface ComponentBehavior {
  /** Fraction of read traffic forwarded to dependencies (caches forward only misses). */
  readPassThrough(component: Component): number;
  /** Fraction of write traffic forwarded to dependencies. */
  writePassThrough(component: Component): number;
  /**
   * Asynchronous components (queues) accept work and return immediately: callers
   * do not wait for, or see errors from, what happens downstream.
   */
  asynchronous: boolean;
}

export interface ComponentTypeDefinition {
  type: ComponentType;
  label: string;
  defaults: {
    capacity: number | null;
    baseLatencyMs: number;
    hourlyCost: number;
    configuration: Record<string, ConfigValue>;
  };
  behavior: ComponentBehavior;
}

const forwardAll: ComponentBehavior = {
  readPassThrough: () => 1,
  writePassThrough: () => 1,
  asynchronous: false,
};

const caching: ComponentBehavior = {
  readPassThrough: (component) => 1 - effectiveHitRate(component),
  writePassThrough: () => 1,
  asynchronous: false,
};

/** Cache hit rate after accounting for health; an unhealthy cache misses more. */
export function effectiveHitRate(component: Component): number {
  const configured = component.configuration["hitRate"];
  const hitRate = typeof configured === "number" ? clamp(configured, 0, 1) : 0;
  return hitRate * HEALTH_PROFILES[component.health].capacityFactor;
}

/**
 * Default characteristics per component type. Numbers are illustrative and
 * internally consistent, not real cloud pricing or benchmarks.
 */
export const COMPONENT_CATALOG: Readonly<Record<ComponentType, ComponentTypeDefinition>> = {
  client: {
    type: "client",
    label: "Client",
    defaults: { capacity: null, baseLatencyMs: 0, hourlyCost: 0, configuration: {} },
    behavior: forwardAll,
  },
  apiGateway: {
    type: "apiGateway",
    label: "API Gateway",
    // `rateLimit` (rps, 0 = off) rejects excess requests before they reach dependencies.
    defaults: { capacity: 5000, baseLatencyMs: 2, hourlyCost: 0.1, configuration: { rateLimit: 0 } },
    behavior: forwardAll,
  },
  loadBalancer: {
    type: "loadBalancer",
    label: "Load Balancer",
    defaults: { capacity: 10000, baseLatencyMs: 1, hourlyCost: 0.03, configuration: {} },
    behavior: forwardAll,
  },
  application: {
    type: "application",
    label: "Application",
    // `memoryBaseline` is idle memory use (0..1); load adds to it.
    defaults: { capacity: 200, baseLatencyMs: 20, hourlyCost: 0.15, configuration: { memoryBaseline: 0.3 } },
    behavior: forwardAll,
  },
  cache: {
    type: "cache",
    label: "Cache",
    defaults: { capacity: 20000, baseLatencyMs: 1, hourlyCost: 0.25, configuration: { hitRate: 0.8 } },
    behavior: caching,
  },
  database: {
    type: "database",
    label: "Database",
    defaults: { capacity: 1000, baseLatencyMs: 10, hourlyCost: 1, configuration: {} },
    behavior: forwardAll,
  },
  databaseReplica: {
    type: "databaseReplica",
    label: "Database Replica",
    defaults: { capacity: 1000, baseLatencyMs: 10, hourlyCost: 0.8, configuration: {} },
    behavior: forwardAll,
  },
  queue: {
    type: "queue",
    label: "Queue",
    // `maxDepth` (messages, 0 = unbounded): once full, the queue rejects what consumers cannot take.
    defaults: { capacity: 10000, baseLatencyMs: 3, hourlyCost: 0.15, configuration: { maxDepth: 0 } },
    behavior: { ...forwardAll, asynchronous: true },
  },
  objectStorage: {
    type: "objectStorage",
    label: "Object Storage",
    defaults: { capacity: null, baseLatencyMs: 30, hourlyCost: 0.05, configuration: {} },
    behavior: forwardAll,
  },
  cdn: {
    type: "cdn",
    label: "CDN",
    defaults: { capacity: null, baseLatencyMs: 5, hourlyCost: 0.4, configuration: { hitRate: 0.9 } },
    behavior: caching,
  },
  worker: {
    type: "worker",
    label: "Worker",
    defaults: { capacity: 150, baseLatencyMs: 40, hourlyCost: 0.12, configuration: { memoryBaseline: 0.3 } },
    behavior: forwardAll,
  },
};
