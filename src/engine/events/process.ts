import type { EventDefinition } from "../../types/index.ts";
import { evaluateCondition, type ConditionContext } from "../conditions/evaluate.ts";

/** Events that should fire now, in declaration order. Each event fires at most once. */
export function dueEvents(
  events: readonly EventDefinition[],
  context: ConditionContext,
  fired: ReadonlySet<string>,
): EventDefinition[] {
  return events.filter((event) => {
    if (fired.has(event.id)) return false;
    if ("at" in event.trigger) return context.state.time >= event.trigger.at;
    return evaluateCondition(event.trigger.when, context);
  });
}
