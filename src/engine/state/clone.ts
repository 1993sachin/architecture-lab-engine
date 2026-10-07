import type { SystemState } from "../../types/index.ts";

/** Deep copy of a state. The engine never mutates a state it has handed out. */
export function cloneState(state: SystemState): SystemState {
  return structuredClone(state);
}
