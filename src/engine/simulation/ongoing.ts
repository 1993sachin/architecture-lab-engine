import type { OngoingEffect, SystemState } from "../../types/index.ts";
import { evaluateCondition } from "../conditions/evaluate.ts";
import { applyEffectsInPlace } from "../effects/apply.ts";
import { EffectError } from "../errors.ts";

export interface ActiveOngoingEffect {
  /** The decision or event that started it. */
  sourceId: string;
  effect: OngoingEffect;
  startedAt: number;
}

export interface OngoingApplication {
  active: ActiveOngoingEffect[];
  /** Ids (`source/effect`) applied this tick. */
  applied: string[];
  /** Ids that stopped this tick, and why. */
  stopped: string[];
}

/**
 * Applies ongoing effects due at the state's current time, in activation order.
 * An effect stops when its duration ends, its `until` condition holds, or it no
 * longer fits the system (for example, its component was removed).
 */
export function applyOngoingEffects(
  state: SystemState,
  active: readonly ActiveOngoingEffect[],
  decisionsTaken: readonly string[],
): OngoingApplication {
  const remaining: ActiveOngoingEffect[] = [];
  const applied: string[] = [];
  const stopped: string[] = [];
  for (const entry of active) {
    const id = `${entry.sourceId}/${entry.effect.id}`;
    const elapsed = state.time - entry.startedAt;
    const interval = entry.effect.interval ?? 1;
    if (entry.effect.duration !== undefined && elapsed > entry.effect.duration) {
      stopped.push(`${id}: finished`);
      continue;
    }
    if (entry.effect.until && evaluateCondition(entry.effect.until, { state, decisionsTaken })) {
      stopped.push(`${id}: condition reached`);
      continue;
    }
    if (elapsed > 0 && elapsed % interval === 0) {
      try {
        applyEffectsInPlace(state, entry.effect.effects);
        applied.push(id);
      } catch (error) {
        if (!(error instanceof EffectError)) throw error;
        stopped.push(`${id}: ${error.message}`);
        continue;
      }
    }
    remaining.push(entry);
  }
  return { active: remaining, applied, stopped };
}
