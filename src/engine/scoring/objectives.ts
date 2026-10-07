import type { Objective, ObjectiveResult } from "../../types/index.ts";
import { evaluateCondition, type ConditionContext } from "../conditions/evaluate.ts";

/** Watches `throughout` objectives at every observation and evaluates `final` ones on demand. */
export class ObjectiveTracker {
  readonly #objectives: readonly Objective[];
  #firstFailedAt = new Map<string, number>();

  constructor(objectives: readonly Objective[]) {
    this.#objectives = objectives;
  }

  observe(context: ConditionContext): void {
    for (const objective of this.#objectives) {
      if ((objective.evaluation ?? "final") !== "throughout" || this.#firstFailedAt.has(objective.id)) continue;
      if (!evaluateCondition(objective.condition, context)) this.#firstFailedAt.set(objective.id, context.state.time);
    }
  }

  results(finalContext: ConditionContext): ObjectiveResult[] {
    return this.#objectives.map((objective) => {
      const evaluation = objective.evaluation ?? "final";
      const firstFailedAt = this.#firstFailedAt.get(objective.id) ?? null;
      const met = evaluation === "throughout" ? firstFailedAt === null : evaluateCondition(objective.condition, finalContext);
      return { objectiveId: objective.id, description: objective.description, evaluation, met, firstFailedAt };
    });
  }
}
