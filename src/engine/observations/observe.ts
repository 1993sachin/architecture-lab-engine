import type { MetricId, Observation, ObservedValue, SystemState } from "../../types/index.ts";
import { METRIC_DEFINITIONS, formatMetric } from "../metrics/definitions.ts";
import { findComponent } from "../state/lookup.ts";
import { round } from "../state/numeric.ts";

/** Reads an observation from a state. Never changes the state. */
export function observe(observation: Observation, state: SystemState): ObservedValue {
  const { signal } = observation;
  const base = { id: observation.id, label: observation.label };
  switch (signal.kind) {
    case "metric": {
      const value = state.metrics[signal.metric];
      return value === undefined
        ? { ...base, value: null, text: `${observation.label}: not available` }
        : { ...base, value, text: `${observation.label}: ${formatMetric(signal.metric, value)}` };
    }
    case "workload": {
      const value = state.workload[signal.property];
      const text =
        signal.property === "readRatio"
          ? `${observation.label}: reads are ${round(value * 100, 1)}% of traffic, writes ${round((1 - value) * 100, 1)}%`
          : `${observation.label}: ${round(value, 1)} rps`;
      return { ...base, value, text };
    }
    case "component": {
      const component = findComponent(state, signal.componentId);
      if (!component) return { ...base, value: null, text: `${observation.label}: not available` };
      switch (signal.property) {
        case "utilization":
          return { ...base, value: component.utilization, text: `${observation.label}: ${round(component.utilization * 100, 1)}%` };
        case "health":
          return { ...base, value: component.health, text: `${observation.label}: ${component.health}` };
        case "latencyMs":
          return { ...base, value: component.load.latencyMs, text: `${observation.label}: ${round(component.load.latencyMs, 1)} ms` };
        case "errorRate":
          return { ...base, value: component.load.errorRate, text: `${observation.label}: ${round(component.load.errorRate * 100, 2)}%` };
        case "instances":
          return { ...base, value: component.instances, text: `${observation.label}: ${component.instances}` };
      }
    }
  }
}

/** The default when a scenario declares no observations: every tracked metric, visible. */
export function defaultObservations(tracked: readonly MetricId[] | null): Observation[] {
  const metrics = tracked ?? (Object.keys(METRIC_DEFINITIONS) as MetricId[]);
  return metrics.map((metric) => ({ id: metric, label: METRIC_DEFINITIONS[metric].label, signal: { kind: "metric", metric } }));
}
