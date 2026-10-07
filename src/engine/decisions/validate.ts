import type { DecisionDefinition, DecisionPreview, DecisionValidation, MetricId, SystemState } from "../../types/index.ts";
import { describeCondition, evaluateCondition } from "../conditions/evaluate.ts";
import { blockingViolations } from "../constraints/check.ts";
import { subtractCosts, totalCost } from "../costs/cost.ts";
import { EffectError } from "../errors.ts";
import { diffStates } from "../history/consequences.ts";
import { round } from "../state/numeric.ts";
import { applyDecision } from "./apply.ts";

export interface DecisionContext {
  state: SystemState;
  decisions: readonly DecisionDefinition[];
  decisionsTaken: readonly string[];
  tracked: readonly MetricId[] | null;
}

/** Projects the effect of a decision without changing anything. Throws `EffectError` if it cannot apply. */
export function previewDecision(context: DecisionContext, decision: DecisionDefinition): DecisionPreview {
  const application = applyDecision(context.state, decision, context.decisionsTaken, context.tracked);
  let counter = 0;
  return {
    decisionId: decision.id,
    projectedState: application.state,
    costDelta: subtractCosts(totalCost(application.state), totalCost(context.state)),
    complexityDelta: round(application.state.complexityScore - context.state.complexityScore, 2),
    sideEffects: application.sideEffects,
    consequences: diffStates(context.state, application.state, { kind: "decision", decisionId: decision.id }, () => `preview-${++counter}`),
  };
}

/**
 * Classifies a decision:
 * - `invalid`: unknown, already taken, prerequisites unmet, or cannot apply to this system;
 * - `unavailable`: resources or blocking constraints prevent it;
 * - `valid`: it can be executed.
 */
export function validateDecision(context: DecisionContext, decisionId: string): DecisionValidation {
  const decision = context.decisions.find((candidate) => candidate.id === decisionId);
  if (!decision) return invalid(decisionId, [`Unknown decision "${decisionId}".`]);

  if (!decision.repeatable && context.decisionsTaken.includes(decisionId)) {
    return invalid(decisionId, [`"${decision.title}" has already been taken.`]);
  }

  const conditionContext = { state: context.state, decisionsTaken: context.decisionsTaken };
  const unmet = (decision.prerequisites ?? [])
    .filter((prerequisite) => !evaluateCondition(prerequisite.condition, conditionContext))
    .map((prerequisite) => prerequisite.message ?? `Requires ${describeCondition(prerequisite.condition)}.`);
  if (unmet.length > 0) return invalid(decisionId, unmet);

  let preview: DecisionPreview;
  try {
    preview = previewDecision(context, decision);
  } catch (error) {
    if (error instanceof EffectError) return invalid(decisionId, [`Cannot be applied to the current system: ${error.message}`]);
    throw error;
  }

  const reasons: string[] = [];
  for (const [resource, amount] of Object.entries(decision.requires ?? {})) {
    const available = context.state.resources[resource] ?? 0;
    if (available < amount) reasons.push(`Requires ${amount} ${resource}; only ${available} available.`);
  }
  reasons.push(
    ...blockingViolations(conditionContext, {
      state: preview.projectedState,
      decisionsTaken: [...context.decisionsTaken, decisionId],
    }),
  );
  if (reasons.length > 0) return { status: "unavailable", decisionId, reason: reasons.join(" "), reasons, preview };

  return { status: "valid", decisionId, preview };
}

function invalid(decisionId: string, reasons: string[]): DecisionValidation {
  return { status: "invalid", decisionId, reason: reasons.join(" "), reasons };
}
