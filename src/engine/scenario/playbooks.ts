import type { PlaybookStep, Scenario, SimulationAction } from "../../types/index.ts";

/**
 * Turns timed playbook steps into replayable actions. Steps scheduled for a
 * time that has already passed (because an earlier decision took time) run
 * immediately.
 */
export function playbookActions(steps: readonly PlaybookStep[], scenario: Scenario): SimulationAction[] {
  const actions: SimulationAction[] = [];
  let time = 0;
  for (const step of steps) {
    if (step.at > time) {
      actions.push({ type: "advance", minutes: step.at - time });
      time = step.at;
    }
    actions.push({ type: "decide", decisionId: step.decision, rationale: step.rationale });
    time += scenario.decisions.find((decision) => decision.id === step.decision)?.duration ?? 0;
  }
  return actions;
}
