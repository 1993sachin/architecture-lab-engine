import type { ComparisonOperator, Condition, SystemState } from "../../types/index.ts";
import { METRIC_DEFINITIONS, formatMetric } from "../metrics/definitions.ts";
import { findComponent } from "../state/lookup.ts";

export interface ConditionContext {
  state: SystemState;
  /** Decisions taken so far, in order. */
  decisionsTaken: readonly string[];
}

export function compare(actual: number, op: ComparisonOperator, expected: number): boolean {
  switch (op) {
    case "<":
      return actual < expected;
    case "<=":
      return actual <= expected;
    case ">":
      return actual > expected;
    case ">=":
      return actual >= expected;
    case "==":
      return actual === expected;
    case "!=":
      return actual !== expected;
  }
}

/** Evaluates a condition. Conditions about missing metrics or components are false. */
export function evaluateCondition(condition: Condition, context: ConditionContext): boolean {
  const { state } = context;
  switch (condition.type) {
    case "metric": {
      const value = state.metrics[condition.metric];
      return value !== undefined && compare(value, condition.op, condition.value);
    }
    case "workload":
      return compare(state.workload[condition.property], condition.op, condition.value);
    case "complexity":
      return compare(state.complexityScore, condition.op, condition.value);
    case "time":
      return compare(state.time, condition.op, condition.value);
    case "resource":
      return compare(state.resources[condition.resource] ?? 0, condition.op, condition.value);
    case "flag":
      return state.flags[condition.flag] === condition.equals;
    case "componentExists":
      return findComponent(state, condition.componentId) !== undefined;
    case "componentHealth": {
      const component = findComponent(state, condition.componentId);
      const allowed = Array.isArray(condition.health) ? condition.health : [condition.health];
      return component !== undefined && allowed.includes(component.health);
    }
    case "componentUtilization": {
      const component = findComponent(state, condition.componentId);
      return component !== undefined && compare(component.utilization, condition.op, condition.value);
    }
    case "decisionTaken":
      return context.decisionsTaken.includes(condition.decisionId);
    case "all":
      return condition.conditions.every((inner) => evaluateCondition(inner, context));
    case "any":
      return condition.conditions.some((inner) => evaluateCondition(inner, context));
    case "not":
      return !evaluateCondition(condition.condition, context);
  }
}

/** A readable description, used in validation messages and results. */
export function describeCondition(condition: Condition): string {
  switch (condition.type) {
    case "metric":
      return `${METRIC_DEFINITIONS[condition.metric].label} ${condition.op} ${formatMetric(condition.metric, condition.value)}`;
    case "workload":
      return `workload ${condition.property} ${condition.op} ${condition.value}`;
    case "complexity":
      return `complexity score ${condition.op} ${condition.value}`;
    case "time":
      return `time ${condition.op} T+${condition.value} min`;
    case "resource":
      return `${condition.resource} ${condition.op} ${condition.value}`;
    case "flag":
      return `${condition.flag} is ${String(condition.equals)}`;
    case "componentExists":
      return `component "${condition.componentId}" exists`;
    case "componentHealth": {
      const allowed = Array.isArray(condition.health) ? condition.health.join(" or ") : condition.health;
      return `component "${condition.componentId}" is ${allowed}`;
    }
    case "componentUtilization":
      return `component "${condition.componentId}" utilization ${condition.op} ${condition.value}`;
    case "decisionTaken":
      return `decision "${condition.decisionId}" has been taken`;
    case "all":
      return condition.conditions.map(describeCondition).join(" and ");
    case "any":
      return condition.conditions.map(describeCondition).join(" or ");
    case "not":
      return `not (${describeCondition(condition.condition)})`;
  }
}
