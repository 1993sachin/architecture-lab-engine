import type { Condition } from "./conditions.ts";
import type { Effect, OngoingEffect } from "./effects.ts";

export type EventTrigger =
  /** Fires once when logical time reaches `at` minutes. */
  | { at: number }
  /** Fires once, the first time `when` holds at the end of a tick. */
  | { when: Condition };

/** Something that changes the situation independently of the engineer. */
export interface EventDefinition {
  id: string;
  title: string;
  description: string;
  trigger: EventTrigger;
  effects: Effect[];
  ongoingEffects?: OngoingEffect[];
}

export interface FiredEvent {
  eventId: string;
  title: string;
  description: string;
  time: number;
}
