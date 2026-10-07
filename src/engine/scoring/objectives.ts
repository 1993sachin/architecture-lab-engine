import type { Objective, ObjectiveResult } from "../../types/index.ts";
import { evaluateCondition, type ConditionContext } from "../conditions/evaluate.ts";

/**
 * Watches objectives as the run progresses:
 * - `throughout`: remembers the first time the condition failed;
 * - `fractionOfTime`: counts the minutes during which it held (judged at the end of each tick);
 * - `final`: evaluated on demand against the final state.
 */
export class ObjectiveTracker {
  readonly #objectives: readonly Objective[];
  #firstFailedAt = new Map<string, number>();
  #minutesHeld = new Map<string, number>();
  #minutes = 0;

  constructor(objectives: readonly Objective[]) {
    this.#objectives = objectives;
  }

  /** Call after every change. `minutes` is the logical time that just elapsed (0 for decisions). */
  observe(context: ConditionContext, minutes: number): void {
    this.#minutes += minutes;
    for (const objective of this.#objectives) {
      const evaluation = objective.evaluation ?? "final";
      if (evaluation === "final") continue;
      const holds = evaluateCondition(objective.condition, context);
      if (!holds && !this.#firstFailedAt.has(objective.id)) this.#firstFailedAt.set(objective.id, context.state.time);
      if (holds && minutes > 0) this.#minutesHeld.set(objective.id, (this.#minutesHeld.get(objective.id) ?? 0) + minutes);
    }
  }

  results(finalContext: ConditionContext): ObjectiveResult[] {
    return this.#objectives.map((objective) => {
      const evaluation = objective.evaluation ?? "final";
      const firstFailedAt = this.#firstFailedAt.get(objective.id) ?? null;
      const holdsNow = evaluateCondition(objective.condition, finalContext);
      const achieved =
        evaluation === "final" ? (holdsNow ? 1 : 0) : this.#minutes > 0 ? (this.#minutesHeld.get(objective.id) ?? 0) / this.#minutes : holdsNow ? 1 : 0;
      let met: boolean;
      if (evaluation === "final") met = holdsNow;
      else if (evaluation === "throughout") met = firstFailedAt === null;
      else met = achieved >= (objective.threshold ?? 1);
      return {
        objectiveId: objective.id,
        description: objective.description,
        evaluation,
        met,
        achieved: Math.round(achieved * 10000) / 10000,
        firstFailedAt: evaluation === "final" ? null : firstFailedAt,
      };
    });
  }
}
