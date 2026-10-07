import type { Component, ComponentSpec, Constraint, Dependency, Effect, SystemState } from "../../types/index.ts";
import { COMPONENT_TYPES } from "../../types/index.ts";
import { createComponent } from "../components/factory.ts";
import { fromHourly, toCost } from "../costs/cost.ts";
import { EffectError } from "../errors.ts";
import { cloneState } from "../state/clone.ts";
import { requireComponent } from "../state/lookup.ts";
import { applyNumericChange, clamp } from "../state/numeric.ts";

/**
 * Applies effects to a state in place. Throws `EffectError` if an effect does
 * not fit the state (unknown component, duplicate id, ...). Metrics are not
 * recalculated here; that is a separate step of the pipeline.
 */
export function applyEffectsInPlace(state: SystemState, effects: readonly Effect[]): void {
  for (const effect of effects) applyEffect(state, effect);
}

/** Returns a copy of the state with the effects applied. */
export function applyEffects(state: SystemState, effects: readonly Effect[]): SystemState {
  const next = cloneState(state);
  applyEffectsInPlace(next, effects);
  return next;
}

function applyEffect(state: SystemState, effect: Effect): void {
  switch (effect.type) {
    case "addComponent":
      addComponent(state, effect.component);
      return;
    case "removeComponent":
      requireComponent(state, effect.componentId);
      state.components = state.components.filter((component) => component.id !== effect.componentId);
      state.dependencies = state.dependencies.filter(
        (dependency) => dependency.from !== effect.componentId && dependency.to !== effect.componentId,
      );
      return;
    case "updateComponent": {
      const component = requireComponent(state, effect.componentId);
      if (effect.instances) component.instances = Math.max(0, Math.round(applyNumericChange(component.instances, effect.instances)));
      if (effect.capacity) {
        if (component.capacity === null) throw new EffectError(`Component "${component.id}" has unbounded capacity.`);
        component.capacity = Math.max(0, applyNumericChange(component.capacity, effect.capacity));
      }
      if (effect.baseLatencyMs) component.baseLatencyMs = Math.max(0, applyNumericChange(component.baseLatencyMs, effect.baseLatencyMs));
      if (effect.costPerInstance) component.cost = fromHourly(Math.max(0, applyNumericChange(component.cost.hourly, effect.costPerInstance)));
      return;
    }
    case "setHealth":
      requireComponent(state, effect.componentId).health = effect.health;
      return;
    case "configure": {
      const component = requireComponent(state, effect.componentId);
      if (effect.value !== undefined) {
        component.configuration[effect.key] = effect.value;
      } else if (effect.change) {
        const current = component.configuration[effect.key];
        if (current !== undefined && typeof current !== "number") {
          throw new EffectError(`Configuration "${effect.key}" of "${component.id}" is not numeric.`);
        }
        component.configuration[effect.key] = applyNumericChange(current ?? 0, effect.change);
      }
      return;
    }
    case "connect":
      connect(state, {
        from: effect.dependency.from,
        to: effect.dependency.to,
        traffic: effect.dependency.traffic ?? "all",
        share: effect.dependency.share ?? 1,
      });
      return;
    case "disconnect": {
      const before = state.dependencies.length;
      state.dependencies = state.dependencies.filter(
        (dependency) =>
          !(dependency.from === effect.from && dependency.to === effect.to && (effect.traffic === undefined || dependency.traffic === effect.traffic)),
      );
      if (state.dependencies.length === before) throw new EffectError(`No dependency from "${effect.from}" to "${effect.to}".`);
      return;
    }
    case "redirect":
      redirect(state, effect.target, effect.to, effect.traffic, effect.fraction);
      return;
    case "workload":
      if (effect.requestsPerSecond) state.workload.requestsPerSecond = Math.max(0, applyNumericChange(state.workload.requestsPerSecond, effect.requestsPerSecond));
      if (effect.readRatio) state.workload.readRatio = clamp(applyNumericChange(state.workload.readRatio, effect.readRatio), 0, 1);
      return;
    case "complexity":
      state.complexityScore = Math.max(0, applyNumericChange(state.complexityScore, effect.change));
      return;
    case "additionalCost":
      if (effect.cost === null) delete state.additionalCosts[effect.id];
      else state.additionalCosts[effect.id] = toCost(effect.cost);
      return;
    case "flag":
      state.flags[effect.flag] = effect.value;
      return;
    case "resource":
      state.resources[effect.resource] = applyNumericChange(state.resources[effect.resource] ?? 0, effect.change);
      return;
    case "addConstraint":
      if (state.constraints.some((constraint) => constraint.id === effect.constraint.id)) {
        throw new EffectError(`Constraint "${effect.constraint.id}" already exists.`);
      }
      state.constraints.push(structuredClone(effect.constraint));
      return;
    case "updateConstraint": {
      const constraint = requireConstraint(state, effect.constraintId);
      if (effect.limit) {
        if (!("limit" in constraint)) throw new EffectError(`Constraint "${constraint.id}" has no limit.`);
        constraint.limit = applyNumericChange(constraint.limit, effect.limit);
      }
      if (effect.enforcement) constraint.enforcement = effect.enforcement;
      return;
    }
    case "removeConstraint":
      requireConstraint(state, effect.constraintId);
      state.constraints = state.constraints.filter((constraint) => constraint.id !== effect.constraintId);
      return;
  }
}

function addComponent(state: SystemState, spec: ComponentSpec): Component {
  if (!COMPONENT_TYPES.includes(spec.type)) throw new EffectError(`Unknown component type "${spec.type}".`);
  if (state.components.some((component) => component.id === spec.id)) {
    throw new EffectError(`Component "${spec.id}" already exists.`);
  }
  const component = createComponent(spec);
  state.components.push(component);
  return component;
}

function connect(state: SystemState, dependency: Dependency): void {
  requireComponent(state, dependency.from);
  requireComponent(state, dependency.to);
  if (dependency.from === dependency.to) throw new EffectError(`Component "${dependency.from}" cannot depend on itself.`);
  const existing = state.dependencies.find(
    (edge) => edge.from === dependency.from && edge.to === dependency.to && edge.traffic === dependency.traffic,
  );
  if (existing) existing.share = clamp(dependency.share, 0, 1);
  else state.dependencies.push({ ...dependency, share: clamp(dependency.share, 0, 1) });
}

function redirect(state: SystemState, target: string, to: string, traffic: Dependency["traffic"], fraction: number): void {
  requireComponent(state, target);
  requireComponent(state, to);
  const portion = clamp(fraction, 0, 1);
  const matching = state.dependencies.filter(
    (edge) => edge.to === target && edge.from !== to && (traffic === "all" || edge.traffic === traffic),
  );
  for (const edge of matching) {
    const moved = edge.share * portion;
    edge.share -= moved;
    const existing = state.dependencies.find((other) => other.from === edge.from && other.to === to && other.traffic === edge.traffic);
    if (existing) existing.share = clamp(existing.share + moved, 0, 1);
    else state.dependencies.push({ from: edge.from, to, traffic: edge.traffic, share: moved });
  }
  state.dependencies = state.dependencies.filter((edge) => edge.share > 1e-9);
}

function requireConstraint(state: SystemState, id: string): Constraint {
  const constraint = state.constraints.find((candidate) => candidate.id === id);
  if (!constraint) throw new EffectError(`Constraint "${id}" does not exist.`);
  return constraint;
}
