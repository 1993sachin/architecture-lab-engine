import type { Component, Consequence, ConsequenceSource, Health, SystemState } from "../../types/index.ts";
import { METRIC_IDS } from "../../types/index.ts";
import { METRIC_DEFINITIONS, formatMetric } from "../metrics/definitions.ts";
import { round } from "../state/numeric.ts";

const HEALTH_RANK: Readonly<Record<Health, number>> = { healthy: 0, degraded: 1, unhealthy: 2, down: 3 };

/** Supplies deterministic, sequential consequence ids. */
export type IdSource = () => string;

/**
 * Describes what changed between two states. Pure and deterministic: the same
 * two states always produce the same consequences in the same order.
 */
export function diffStates(
  before: SystemState,
  after: SystemState,
  source: ConsequenceSource,
  nextId: IdSource,
): Consequence[] {
  const time = after.time;
  const consequences: Consequence[] = [];
  const add = (consequence: Omit<Consequence, "id" | "time" | "source">) =>
    consequences.push({ id: nextId(), time, source, ...consequence });

  const previous = new Map(before.components.map((component) => [component.id, component]));
  const current = new Map(after.components.map((component) => [component.id, component]));

  for (const component of after.components) {
    const old = previous.get(component.id);
    if (!old) {
      add({
        subject: { kind: "component", componentId: component.id, change: "added" },
        before: null,
        after: component.type,
        delta: null,
        impact: "neutral",
        severity: "info",
        description: `Added ${describe(component)}.`,
      });
      continue;
    }
    if (old.instances !== component.instances) {
      add({
        subject: { kind: "component", componentId: component.id, change: "instances" },
        before: old.instances,
        after: component.instances,
        delta: component.instances - old.instances,
        impact: "neutral",
        severity: "info",
        description: `${component.label} scaled from ${old.instances} to ${component.instances} instances.`,
      });
    }
    if (old.health !== component.health) {
      const worse = HEALTH_RANK[component.health] > HEALTH_RANK[old.health];
      add({
        subject: { kind: "component", componentId: component.id, change: "health" },
        before: old.health,
        after: component.health,
        delta: null,
        impact: worse ? "negative" : "positive",
        severity: worse ? (HEALTH_RANK[component.health] >= 2 ? "critical" : "warning") : "info",
        description: `${component.label} became ${component.health} (was ${old.health}).`,
      });
    }
  }
  for (const component of before.components) {
    if (!current.has(component.id)) {
      add({
        subject: { kind: "component", componentId: component.id, change: "removed" },
        before: component.type,
        after: null,
        delta: null,
        impact: "neutral",
        severity: "info",
        description: `Removed ${describe(component)}.`,
      });
    }
  }

  if (before.complexityScore !== after.complexityScore) {
    const delta = round(after.complexityScore - before.complexityScore, 2);
    add({
      subject: { kind: "complexity" },
      before: before.complexityScore,
      after: after.complexityScore,
      delta,
      impact: delta > 0 ? "negative" : "positive",
      severity: "info",
      description: `Complexity ${delta > 0 ? "increased" : "decreased"} from ${before.complexityScore} to ${after.complexityScore}.`,
    });
  }

  for (const metric of METRIC_IDS) {
    const definition = METRIC_DEFINITIONS[metric];
    const old = before.metrics[metric];
    const value = after.metrics[metric];
    if (old === undefined && value === undefined) continue;
    if (old === undefined || value === undefined) {
      add({
        subject: { kind: "metric", metric },
        before: old ?? null,
        after: value ?? null,
        delta: null,
        impact: "neutral",
        severity: "info",
        description: value === undefined ? `${definition.label} is no longer measured.` : `${definition.label} is now measured: ${formatMetric(metric, value)}.`,
      });
      continue;
    }
    const delta = round(value - old, 4);
    if (Math.abs(delta) < definition.significantChange) continue;
    const improved = definition.betterWhen === "lower" ? delta < 0 : delta > 0;
    const impact = definition.betterWhen === "neutral" ? "neutral" : improved ? "positive" : "negative";
    add({
      subject: { kind: "metric", metric },
      before: old,
      after: value,
      delta,
      impact,
      severity: impact === "negative" ? (isSevere(definition.unit, old, delta) ? "critical" : "warning") : "info",
      description: describeChange(metric, old, value),
    });
  }

  return consequences;
}

function isSevere(unit: string, before: number, delta: number): boolean {
  if (unit === "ratio") return Math.abs(delta) >= 0.05;
  return before > 0 ? Math.abs(delta) / before >= 1 : true;
}

function describeChange(metric: (typeof METRIC_IDS)[number], before: number, after: number): string {
  const definition = METRIC_DEFINITIONS[metric];
  const direction = after > before ? "increased" : "decreased";
  const relative = definition.unit !== "ratio" && before !== 0 ? ` (${after > before ? "+" : ""}${round(((after - before) / before) * 100, 1)}%)` : "";
  return `${definition.label} ${direction} from ${formatMetric(metric, before)} to ${formatMetric(metric, after)}${relative}.`;
}

function describe(component: Component): string {
  return `${component.label} (${component.type}, ${component.instances} instance${component.instances === 1 ? "" : "s"})`;
}
