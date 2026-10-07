import type {
  Condition,
  Dependency,
  Effect,
  MetricId,
  OngoingEffect,
  Scenario,
  ScenarioDefinition,
  SystemState,
} from "../../types/index.ts";
import { COMPONENT_TYPES, METRIC_IDS } from "../../types/index.ts";
import { createComponent } from "../components/factory.ts";
import { graphIssues } from "../components/graph.ts";
import { toCost } from "../costs/cost.ts";
import { ScenarioValidationError } from "../errors.ts";
import { calculateMetricsInPlace } from "../metrics/calculate.ts";
import { defaultObservations } from "../observations/observe.ts";

/**
 * Identity helper that gives scenario literals full type checking.
 * Validation happens in `createScenario`.
 */
export function defineScenario(definition: ScenarioDefinition): ScenarioDefinition {
  return definition;
}

/**
 * Validates a scenario definition and prepares it for simulation: builds the
 * initial system, calculates its metrics, and freezes everything.
 * Throws `ScenarioValidationError` listing every problem found.
 */
export function createScenario(input: ScenarioDefinition): Scenario {
  // Copy first so later changes to the caller's object cannot leak in.
  const definition = structuredClone(input);
  const issues = validateDefinition(definition);
  if (issues.length > 0) throw new ScenarioValidationError(definition.id || "(unnamed)", issues);

  const timeStep = definition.timeStep ?? 1;
  const tracked = definition.metrics ? [...definition.metrics] : null;
  const initialState = buildInitialState(definition);
  calculateMetricsInPlace(initialState, tracked);

  return deepFreeze({
    id: definition.id,
    title: definition.title,
    description: definition.description ?? "",
    timeStep,
    metrics: tracked,
    observations: definition.observations ?? defaultObservations(tracked),
    initialState,
    decisions: definition.decisions,
    events: definition.events ?? [],
    objectives: definition.objectives,
    completion: definition.completion,
    definition,
  });
}

function buildInitialState(definition: ScenarioDefinition): SystemState {
  const spec = definition.initialState;
  const dependencies: Dependency[] = spec.dependencies.map((dependency) => ({
    from: dependency.from,
    to: dependency.to,
    traffic: dependency.traffic ?? "all",
    share: dependency.share ?? 1,
  }));
  const additionalCosts: SystemState["additionalCosts"] = {};
  for (const [id, cost] of Object.entries(spec.additionalCosts ?? {})) additionalCosts[id] = toCost(cost);
  return {
    time: 0,
    workload: { ...definition.workload },
    components: spec.components.map(createComponent),
    dependencies,
    additionalCosts,
    complexityScore: spec.complexityScore ?? 0,
    resources: { ...definition.resources },
    flags: { ...spec.flags },
    constraints: structuredClone(definition.constraints ?? []),
    metrics: {},
  };
}

function validateDefinition(definition: ScenarioDefinition): string[] {
  const issues: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) issues.push(message);
  };
  const isNonNegative = (value: number) => Number.isFinite(value) && value >= 0;

  check(typeof definition.id === "string" && definition.id.length > 0, "Scenario id is required.");
  check(typeof definition.title === "string" && definition.title.length > 0, "Scenario title is required.");
  const timeStep = definition.timeStep ?? 1;
  check(Number.isInteger(timeStep) && timeStep > 0, "timeStep must be a positive whole number of minutes.");
  check(isNonNegative(definition.workload.requestsPerSecond), "workload.requestsPerSecond must be a non-negative number.");
  check(definition.workload.readRatio >= 0 && definition.workload.readRatio <= 1, "workload.readRatio must be between 0 and 1.");
  for (const metric of definition.metrics ?? []) check(METRIC_IDS.includes(metric), `Unknown metric "${metric}".`);

  const components = definition.initialState.components;
  for (const component of components) {
    check(COMPONENT_TYPES.includes(component.type), `Component "${component.id}" has unknown type "${component.type}".`);
    if (component.instances !== undefined) check(Number.isInteger(component.instances) && component.instances >= 0, `Component "${component.id}" instances must be a whole number.`);
    if (component.capacity !== undefined && component.capacity !== null) check(isNonNegative(component.capacity), `Component "${component.id}" capacity must be non-negative.`);
  }
  if (issues.length === 0) {
    const built = components.map(createComponent);
    const dependencies = definition.initialState.dependencies.map((dependency) => ({
      from: dependency.from,
      to: dependency.to,
      traffic: dependency.traffic ?? "all",
      share: dependency.share ?? 1,
    }));
    issues.push(...graphIssues(built, dependencies));
  }

  issues.push(...duplicates("constraint", (definition.constraints ?? []).map((constraint) => constraint.id)));
  issues.push(...duplicates("decision", definition.decisions.map((decision) => decision.id)));
  issues.push(...duplicates("event", (definition.events ?? []).map((event) => event.id)));
  issues.push(...duplicates("objective", definition.objectives.map((objective) => objective.id)));
  issues.push(...duplicates("observation", (definition.observations ?? []).map((observation) => observation.id)));
  const observationIds = new Set((definition.observations ?? defaultObservations(definition.metrics ?? null)).map((observation) => observation.id));
  for (const observation of definition.observations ?? []) {
    if (observation.signal.kind === "metric") check(METRIC_IDS.includes(observation.signal.metric), `Observation "${observation.id}" uses unknown metric "${observation.signal.metric}".`);
  }

  for (const decision of definition.decisions) {
    const where = `Decision "${decision.id}"`;
    check(decision.title.length > 0, `${where} needs a title.`);
    check(Number.isFinite(decision.complexityImpact), `${where} complexityImpact must be a number.`);
    for (const prerequisite of decision.prerequisites ?? []) issues.push(...conditionIssues(prerequisite.condition, where));
    for (const sideEffect of decision.sideEffects ?? []) {
      if (sideEffect.when) issues.push(...conditionIssues(sideEffect.when, where));
      issues.push(...effectIssues(sideEffect.effects, where));
    }
    issues.push(...effectIssues(decision.immediateEffects, where));
    issues.push(...ongoingIssues(decision.ongoingEffects ?? [], where));
    for (const id of decision.reveals ?? []) check(observationIds.has(id), `${where} reveals unknown observation "${id}".`);
    if (decision.duration !== undefined) {
      check(Number.isInteger(decision.duration) && decision.duration >= 0 && decision.duration % timeStep === 0, `${where} duration must be a whole multiple of timeStep.`);
    }
    for (const [resource, amount] of Object.entries(decision.requires ?? {})) {
      check(isNonNegative(amount), `${where} requires a negative amount of "${resource}".`);
    }
  }

  for (const event of definition.events ?? []) {
    const where = `Event "${event.id}"`;
    if ("at" in event.trigger) {
      check(Number.isInteger(event.trigger.at) && event.trigger.at >= 0, `${where} must trigger at a whole, non-negative minute.`);
    } else {
      issues.push(...conditionIssues(event.trigger.when, where));
    }
    issues.push(...effectIssues(event.effects, where));
    issues.push(...ongoingIssues(event.ongoingEffects ?? [], where));
  }

  for (const constraint of definition.constraints ?? []) {
    const where = `Constraint "${constraint.id}"`;
    if (constraint.kind === "metric") check(METRIC_IDS.includes(constraint.metric), `${where} uses unknown metric "${constraint.metric}".`);
    if (constraint.kind === "requirement" || constraint.kind === "deadline") issues.push(...conditionIssues(constraint.condition, where));
  }

  check(definition.objectives.length > 0, "A scenario needs at least one objective.");
  for (const objective of definition.objectives) {
    issues.push(...conditionIssues(objective.condition, `Objective "${objective.id}"`));
    if (objective.evaluation === "fractionOfTime") {
      const threshold = objective.threshold;
      check(threshold !== undefined && threshold >= 0 && threshold <= 1, `Objective "${objective.id}" needs a threshold between 0 and 1.`);
    }
  }

  const { maxDuration, endWhen, failWhen } = definition.completion;
  check(Number.isInteger(maxDuration) && maxDuration > 0, "completion.maxDuration must be a positive whole number of minutes.");
  check(maxDuration % timeStep === 0, "completion.maxDuration must be a multiple of timeStep.");
  if (endWhen) issues.push(...conditionIssues(endWhen, "completion.endWhen"));
  if (failWhen) issues.push(...conditionIssues(failWhen, "completion.failWhen"));

  return issues;
}

function duplicates(kind: string, ids: string[]): string[] {
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const id of ids) {
    if (!id) issues.push(`Every ${kind} needs an id.`);
    else if (seen.has(id)) issues.push(`Duplicate ${kind} id "${id}".`);
    seen.add(id);
  }
  return issues;
}

function conditionIssues(condition: Condition, where: string): string[] {
  switch (condition.type) {
    case "metric":
      return METRIC_IDS.includes(condition.metric) ? [] : [`${where} uses unknown metric "${condition.metric}".`];
    case "all":
    case "any":
      return condition.conditions.flatMap((inner) => conditionIssues(inner, where));
    case "not":
      return conditionIssues(condition.condition, where);
    default:
      return [];
  }
}

function effectIssues(effects: readonly Effect[], where: string): string[] {
  const issues: string[] = [];
  for (const effect of effects) {
    if (effect.type === "addComponent" && !COMPONENT_TYPES.includes(effect.component.type)) {
      issues.push(`${where} adds a component of unknown type "${effect.component.type}".`);
    }
    if (effect.type === "redirect" && !(effect.fraction >= 0 && effect.fraction <= 1)) {
      issues.push(`${where} redirects a fraction outside 0..1.`);
    }
    if (effect.type === "configure" && effect.value === undefined && effect.change === undefined) {
      issues.push(`${where} configures "${effect.key}" without a value or change.`);
    }
    if (effect.type === "addConstraint" && effect.constraint.kind === "metric" && !METRIC_IDS.includes(effect.constraint.metric as MetricId)) {
      issues.push(`${where} adds a constraint on unknown metric "${effect.constraint.metric}".`);
    }
  }
  return issues;
}

function ongoingIssues(ongoing: readonly OngoingEffect[], where: string): string[] {
  const issues: string[] = [];
  for (const effect of ongoing) {
    const interval = effect.interval ?? 1;
    if (!(Number.isInteger(interval) && interval > 0)) issues.push(`${where} ongoing effect "${effect.id}" needs a positive whole interval.`);
    if (effect.until) issues.push(...conditionIssues(effect.until, where));
    issues.push(...effectIssues(effect.effects, where));
  }
  return issues;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}
