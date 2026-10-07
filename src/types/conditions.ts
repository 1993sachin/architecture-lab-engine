import type { ConfigValue, Health } from "./components.ts";
import type { MetricId } from "./metrics.ts";

export type ComparisonOperator = "<" | "<=" | ">" | ">=" | "==" | "!=";

/** Declarative, serializable predicates over the simulation state. */
export type Condition =
  | { type: "metric"; metric: MetricId; op: ComparisonOperator; value: number }
  | { type: "workload"; property: "requestsPerSecond" | "readRatio"; op: ComparisonOperator; value: number }
  | { type: "complexity"; op: ComparisonOperator; value: number }
  | { type: "time"; op: ComparisonOperator; value: number }
  | { type: "resource"; resource: string; op: ComparisonOperator; value: number }
  | { type: "flag"; flag: string; equals: ConfigValue }
  | { type: "componentExists"; componentId: string }
  | { type: "componentHealth"; componentId: string; health: Health | Health[] }
  | { type: "componentUtilization"; componentId: string; op: ComparisonOperator; value: number }
  | { type: "decisionTaken"; decisionId: string }
  | { type: "all"; conditions: Condition[] }
  | { type: "any"; conditions: Condition[] }
  | { type: "not"; condition: Condition };
