import type { Constraint, ConstraintCheck, ConstraintEnforcement } from "../../types/index.ts";
import { describeCondition, evaluateCondition, type ConditionContext } from "../conditions/evaluate.ts";
import { formatUsd, totalCost } from "../costs/cost.ts";
import { METRIC_DEFINITIONS, formatMetric } from "../metrics/definitions.ts";
import { round } from "../state/numeric.ts";

export function enforcementOf(constraint: Constraint): ConstraintEnforcement {
  if (constraint.enforcement) return constraint.enforcement;
  return constraint.kind === "metric" || constraint.kind === "deadline" ? "monitor" : "block";
}

export function checkConstraint(constraint: Constraint, context: ConditionContext): ConstraintCheck {
  const { state } = context;
  const base = { constraintId: constraint.id, kind: constraint.kind };
  switch (constraint.kind) {
    case "budget": {
      const actual = totalCost(state).monthly;
      const satisfied = actual <= constraint.limit;
      return {
        ...base,
        satisfied,
        actual,
        limit: constraint.limit,
        message: satisfied
          ? `Monthly cost ${formatUsd(actual)} is within the ${formatUsd(constraint.limit)} budget.`
          : `Monthly budget exceeded by ${formatUsd(actual - constraint.limit)} (${formatUsd(actual)} of ${formatUsd(constraint.limit)}).`,
      };
    }
    case "complexity": {
      const actual = state.complexityScore;
      const satisfied = actual <= constraint.limit;
      return {
        ...base,
        satisfied,
        actual,
        limit: constraint.limit,
        message: satisfied
          ? `Complexity ${actual} is within the limit of ${constraint.limit}.`
          : `Complexity ${actual} exceeds the limit of ${constraint.limit}.`,
      };
    }
    case "metric": {
      const actual = state.metrics[constraint.metric];
      const label = METRIC_DEFINITIONS[constraint.metric].label;
      if (actual === undefined) {
        return { ...base, satisfied: true, limit: constraint.limit, message: `${label} is not measured in this system.` };
      }
      const satisfied = constraint.bound === "max" ? actual <= constraint.limit : actual >= constraint.limit;
      const relation = constraint.bound === "max" ? "maximum" : "minimum";
      return {
        ...base,
        satisfied,
        actual,
        limit: constraint.limit,
        message: `${label} is ${formatMetric(constraint.metric, actual)} (${relation} ${formatMetric(constraint.metric, constraint.limit)}).`,
      };
    }
    case "requirement": {
      const satisfied = evaluateCondition(constraint.condition, context);
      return {
        ...base,
        satisfied,
        message: satisfied ? `${constraint.description}: satisfied.` : `${constraint.description}: requires ${describeCondition(constraint.condition)}.`,
      };
    }
    case "deadline": {
      const satisfied = state.time < constraint.limit || evaluateCondition(constraint.condition, context);
      return {
        ...base,
        satisfied,
        limit: constraint.limit,
        message: satisfied
          ? `${constraint.description}: on track.`
          : `${constraint.description}: deadline T+${constraint.limit} min passed without ${describeCondition(constraint.condition)}.`,
      };
    }
  }
}

export function checkConstraints(context: ConditionContext): ConstraintCheck[] {
  return context.state.constraints.map((constraint) => checkConstraint(constraint, context));
}

/**
 * Reasons a change from `before` to `after` is blocked by `block` constraints.
 * A change is blocked only if it introduces or worsens a violation, so a
 * cost-cutting decision stays available even when the budget is already blown.
 */
export function blockingViolations(before: ConditionContext, after: ConditionContext): string[] {
  const reasons: string[] = [];
  for (const constraint of after.state.constraints) {
    if (enforcementOf(constraint) !== "block") continue;
    const next = checkConstraint(constraint, after);
    if (next.satisfied) continue;
    const previousConstraint = before.state.constraints.find((candidate) => candidate.id === constraint.id);
    const previous = previousConstraint ? checkConstraint(previousConstraint, before) : undefined;
    const worsened =
      previous === undefined ||
      previous.satisfied ||
      (next.actual !== undefined && previous.actual !== undefined && worse(constraint, previous.actual, next.actual));
    if (!worsened) continue;
    reasons.push(blockMessage(constraint, next));
  }
  return reasons;
}

function worse(constraint: Constraint, before: number, after: number): boolean {
  if (constraint.kind === "metric" && constraint.bound === "min") return after < before;
  return after > before;
}

function blockMessage(constraint: Constraint, check: ConstraintCheck): string {
  if (constraint.kind === "budget" && check.actual !== undefined) {
    return `Monthly budget would be exceeded by ${formatUsd(check.actual - constraint.limit)}.`;
  }
  if (constraint.kind === "complexity" && check.actual !== undefined) {
    return `Complexity limit would be exceeded: ${round(check.actual, 2)} of ${constraint.limit} (${constraint.description}).`;
  }
  return `Would violate "${constraint.description}": ${check.message}`;
}
