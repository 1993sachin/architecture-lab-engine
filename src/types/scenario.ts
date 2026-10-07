import type { ComponentSpec, ConfigValue, CostInput, DependencySpec } from "./components.ts";
import type { Condition } from "./conditions.ts";
import type { Constraint } from "./constraints.ts";
import type { DecisionDefinition } from "./decisions.ts";
import type { EventDefinition } from "./events.ts";
import type { MetricId } from "./metrics.ts";
import type { Observation } from "./observations.ts";
import type { SystemState, Workload } from "./state.ts";

export type ObjectiveEvaluation = "final" | "throughout" | "fractionOfTime";

export interface Objective {
  id: string;
  description: string;
  condition: Condition;
  /**
   * `final`: must hold at the end (default).
   * `throughout`: must hold at every tick.
   * `fractionOfTime`: must hold for at least `threshold` of the elapsed time.
   */
  evaluation?: ObjectiveEvaluation;
  /** Required fraction (0..1) for `fractionOfTime`. */
  threshold?: number;
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
  /**
   * What the engineer can observe. Defaults to every tracked metric, all visible.
   * Hidden observations are revealed by decisions with `reveals`.
   */
  observations?: Observation[];
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
  readonly observations: readonly Observation[];
  readonly initialState: SystemState;
  readonly decisions: readonly DecisionDefinition[];
  readonly events: readonly EventDefinition[];
  readonly objectives: readonly Objective[];
  readonly completion: CompletionConditions;
  readonly definition: ScenarioDefinition;
}
