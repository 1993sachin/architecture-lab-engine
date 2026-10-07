import type { DecisionDefinition, MetricId, OngoingEffect, SystemState } from "../../types/index.ts";
import { evaluateCondition } from "../conditions/evaluate.ts";
import { addCosts, toCost } from "../costs/cost.ts";
import { applyEffectsInPlace } from "../effects/apply.ts";
import { calculateMetricsInPlace } from "../metrics/calculate.ts";
import { cloneState } from "../state/clone.ts";
import { round } from "../state/numeric.ts";

export interface DecisionApplication {
  /** New state with metrics recalculated. */
  state: SystemState;
  /** Descriptions of side effects that applied. */
  sideEffects: string[];
  /** Ongoing effects to activate now. */
  ongoingEffects: OngoingEffect[];
}

/**
 * Applies a decision's immediate effects, recurring cost, complexity and
 * resource use, then its side effects. Does not validate: callers validate first.
 */
export function applyDecision(
  state: SystemState,
  decision: DecisionDefinition,
  decisionsTaken: readonly string[],
  tracked: readonly MetricId[] | null,
): DecisionApplication {
  const next = cloneState(state);
  applyEffectsInPlace(next, decision.immediateEffects);

  if (decision.costImpact) {
    const key = `decision:${decision.id}`;
    const existing = next.additionalCosts[key];
    const cost = toCost(decision.costImpact);
    next.additionalCosts[key] = existing ? addCosts(existing, cost) : cost;
  }
  next.complexityScore = round(Math.max(0, next.complexityScore + decision.complexityImpact), 2);
  for (const [resource, amount] of Object.entries(decision.requires ?? {})) {
    next.resources[resource] = round((next.resources[resource] ?? 0) - amount, 4);
  }
  calculateMetricsInPlace(next, tracked);

  const context = { state: next, decisionsTaken: [...decisionsTaken, decision.id] };
  const applicable = (decision.sideEffects ?? []).filter(
    (sideEffect) => sideEffect.when === undefined || evaluateCondition(sideEffect.when, context),
  );
  for (const sideEffect of applicable) applyEffectsInPlace(next, sideEffect.effects);
  if (applicable.length > 0) calculateMetricsInPlace(next, tracked);

  return {
    state: next,
    sideEffects: applicable.map((sideEffect) => sideEffect.description),
    ongoingEffects: decision.ongoingEffects ?? [],
  };
}
