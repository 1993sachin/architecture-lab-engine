import type { Component, ComponentLoad, ComponentSpec } from "../../types/index.ts";
import { fromHourly, toCost } from "../costs/cost.ts";
import { COMPONENT_CATALOG } from "./catalog.ts";
import { HEALTH_PROFILES } from "./health.ts";

export const EMPTY_LOAD: Readonly<ComponentLoad> = {
  inbound: 0,
  throttled: 0,
  accepted: 0,
  served: 0,
  outbound: 0,
  ownLatencyMs: 0,
  ownErrorRate: 0,
  latencyMs: 0,
  errorRate: 0,
};

/** Builds a full component from a spec, filling gaps from the catalog. */
export function createComponent(spec: ComponentSpec): Component {
  const definition = COMPONENT_CATALOG[spec.type];
  return {
    id: spec.id,
    type: spec.type,
    label: spec.label ?? definition.label,
    capacity: spec.capacity === undefined ? definition.defaults.capacity : spec.capacity,
    instances: spec.instances ?? 1,
    baseLatencyMs: spec.baseLatencyMs ?? definition.defaults.baseLatencyMs,
    health: spec.health ?? "healthy",
    cost: spec.cost ? toCost(spec.cost) : fromHourly(definition.defaults.hourlyCost),
    configuration: { ...definition.defaults.configuration, ...spec.configuration },
    utilization: 0,
    backlog: 0,
    load: { ...EMPTY_LOAD },
  };
}

/** Requests per second the component can handle right now; `null` when unbounded. */
export function effectiveCapacity(component: Component): number | null {
  if (component.capacity === null) return null;
  return component.capacity * component.instances * HEALTH_PROFILES[component.health].capacityFactor;
}
