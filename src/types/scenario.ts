import type { ComponentSpec, ConfigValue, CostInput, DependencySpec } from "./components.ts";
import type { Condition } from "./conditions.ts";
import type { Constraint } from "./constraints.ts";
import type { DecisionDefinition } from "./decisions.ts";
import type { EventDefinition } from "./events.ts";
import type { MetricId } from "./metrics.ts";
import type { SystemState, Workload } from "./state.ts";

export interface Objective {
  id: string;
  description: string;
  condition: Condition;
  /** `final`: must hold at the end (default). `throughout`: must hold at every tick. */
  evaluation?: "final" | "throughout";
  /** Relative importance for the score. Defaults to 1. */
  weight?: number;
}

export interface CompletionConditions {
  /** The scenario ends when logical time reaches this many minutes. */
  maxDuration: number;
  /** Ends the scenario early (normal completion). */
  endWhen?: Condition;
  /** Ends the scenario early with a failure outcome. */
  failWhen?: Condition;
}

export interface InitialSystemSpec {
  components: ComponentSpec[];
  dependencies: DependencySpec[];
  additionalCosts?: Record<string, CostInput>;
  complexityScore?: number;
  flags?: Record<string, ConfigValue>;
}

/** The declarative scenario format authors write. */
export interface ScenarioDefinition {
  id: string;
  title: string;
  description?: string;
  /** Minutes per tick. Defaults to 1. */
  timeStep?: number;
  /** Metrics to track. Defaults to every applicable metric. */
  metrics?: MetricId[];
  initialState: InitialSystemSpec;
  workload: Workload;
  resources?: Record<string, number>;
  constraints?: Constraint[];
  decisions: DecisionDefinition[];
  events?: EventDefinition[];
  objectives: Objective[];
  completion: CompletionConditions;
}

/** A validated scenario, ready to simulate. */
export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly timeStep: number;
  readonly metrics: readonly MetricId[] | null;
  readonly initialState: SystemState;
  readonly decisions: readonly DecisionDefinition[];
  readonly events: readonly EventDefinition[];
  readonly objectives: readonly Objective[];
  readonly completion: CompletionConditions;
  readonly definition: ScenarioDefinition;
}
