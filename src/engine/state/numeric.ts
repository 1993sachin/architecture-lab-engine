import type { NumericChange } from "../../types/index.ts";

/** Rounds to a fixed number of decimal places, so derived values stay stable and readable. */
export function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Applies set, multiply, add, then clamps to min/max. */
export function applyNumericChange(current: number, change: NumericChange): number {
  let value = change.set ?? current;
  if (change.multiply !== undefined) value *= change.multiply;
  if (change.add !== undefined) value += change.add;
  if (change.min !== undefined) value = Math.max(change.min, value);
  if (change.max !== undefined) value = Math.min(change.max, value);
  return value;
}
