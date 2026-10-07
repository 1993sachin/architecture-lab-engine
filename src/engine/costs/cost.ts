import type { Component, Cost, CostInput, SystemState } from "../../types/index.ts";
import { round } from "../state/numeric.ts";

export const HOURS_PER_MONTH = 730;
export const MINUTES_PER_MONTH = HOURS_PER_MONTH * 60;

export const ZERO_COST: Cost = { hourly: 0, monthly: 0 };

export function toCost(input: CostInput): Cost {
  if ("hourly" in input) return fromHourly(input.hourly);
  return { hourly: round(input.monthly / HOURS_PER_MONTH, 6), monthly: round(input.monthly, 2) };
}

export function fromHourly(hourly: number): Cost {
  return { hourly: round(hourly, 6), monthly: round(hourly * HOURS_PER_MONTH, 2) };
}

export function addCosts(a: Cost, b: Cost): Cost {
  return { hourly: round(a.hourly + b.hourly, 6), monthly: round(a.monthly + b.monthly, 2) };
}

export function subtractCosts(a: Cost, b: Cost): Cost {
  return { hourly: round(a.hourly - b.hourly, 6), monthly: round(a.monthly - b.monthly, 2) };
}

export function componentCost(component: Component): Cost {
  return fromHourly(component.cost.hourly * component.instances);
}

/** Total recurring cost of a system: every component instance plus additional costs. */
export function totalCost(state: SystemState): Cost {
  let total = ZERO_COST;
  for (const component of state.components) total = addCosts(total, componentCost(component));
  for (const cost of Object.values(state.additionalCosts)) total = addCosts(total, cost);
  return total;
}

/** Formats a USD amount deterministically (no locale dependency), e.g. `$1,000` or `-$12.50`. */
export function formatUsd(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  const absolute = Math.abs(round(amount, 2));
  const whole = Math.floor(absolute);
  const cents = Math.round((absolute - whole) * 100);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${grouped}${cents === 0 ? "" : `.${String(cents).padStart(2, "0")}`}`;
}
