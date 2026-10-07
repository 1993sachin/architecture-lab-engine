import type { SystemState } from "../../types/index.ts";
import { round } from "../state/numeric.ts";

/** Logical time label, e.g. `T+0`, `T+5 min`. */
export function formatTime(minutes: number): string {
  return minutes === 0 ? "T+0" : `T+${minutes} min`;
}

/**
 * Moves logical time forward and integrates quantities that accumulate, using
 * the flows calculated at the start of the tick (explicit Euler step).
 */
export function advanceTime(state: SystemState, minutes: number): void {
  state.time += minutes;
  for (const component of state.components) {
    if (component.type !== "queue") continue;
    const net = (component.load.served - component.load.outbound) * 60 * minutes;
    component.backlog = round(Math.max(0, component.backlog + net), 2);
  }
}
