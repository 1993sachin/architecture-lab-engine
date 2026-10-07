import type { Component, SystemState } from "../../types/index.ts";
import { EffectError } from "../errors.ts";

export function findComponent(state: SystemState, id: string): Component | undefined {
  return state.components.find((component) => component.id === id);
}

export function requireComponent(state: SystemState, id: string): Component {
  const component = findComponent(state, id);
  if (!component) throw new EffectError(`Component "${id}" does not exist.`);
  return component;
}
