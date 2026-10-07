import { describe, expect, it } from "vitest";
import { EffectError, applyEffects } from "../src/index.ts";
import { buildScenario, component } from "./helpers.ts";

const initial = buildScenario().initialState;

describe("effects", () => {
  it("never mutates the input state", () => {
    const snapshot = structuredClone(initial);
    applyEffects(initial, [{ type: "updateComponent", componentId: "app", instances: { set: 9 } }]);
    expect(initial).toEqual(snapshot);
  });

  it("applies numeric changes in order: set, multiply, add, clamp", () => {
    const state = applyEffects(initial, [
      { type: "workload", requestsPerSecond: { set: 10, multiply: 3, add: 5, max: 30 } },
      { type: "updateComponent", componentId: "app", instances: { add: -5, min: 1 } },
    ]);
    expect(state.workload.requestsPerSecond).toBe(30);
    expect(component(state, "app").instances).toBe(1);
  });

  it("redirects incoming traffic of one class to a new component", () => {
    const state = applyEffects(initial, [
      { type: "addComponent", component: { id: "replica", type: "databaseReplica" } },
      { type: "redirect", target: "db", to: "replica", traffic: "read", fraction: 0.5 },
    ]);
    expect(state.dependencies).toEqual([
      { from: "client", to: "app", traffic: "all", share: 1 },
      { from: "app", to: "db", traffic: "read", share: 0.5 },
      { from: "app", to: "db", traffic: "write", share: 1 },
      { from: "app", to: "replica", traffic: "read", share: 0.5 },
    ]);
  });

  it("removes components together with their dependencies", () => {
    const state = applyEffects(initial, [{ type: "removeComponent", componentId: "db" }]);
    expect(state.components.map((c) => c.id)).toEqual(["client", "app"]);
    expect(state.dependencies).toEqual([{ from: "client", to: "app", traffic: "all", share: 1 }]);
  });

  it("changes constraints, flags, resources and costs", () => {
    const state = applyEffects(initial, [
      { type: "addConstraint", constraint: { id: "budget", kind: "budget", description: "Budget", limit: 2000 } },
      { type: "updateConstraint", constraintId: "budget", limit: { multiply: 0.5 } },
      { type: "flag", flag: "region", value: "eu" },
      { type: "resource", resource: "engineers", change: { add: 3 } },
      { type: "additionalCost", id: "licence", cost: { monthly: 99 } },
    ]);
    expect(state.constraints).toEqual([{ id: "budget", kind: "budget", description: "Budget", limit: 1000 }]);
    expect(state.flags["region"]).toBe("eu");
    expect(state.resources["engineers"]).toBe(3);
    expect(state.additionalCosts["licence"]?.monthly).toBe(99);
  });

  it("refuses effects that do not fit the system", () => {
    expect(() => applyEffects(initial, [{ type: "setHealth", componentId: "nope", health: "down" }])).toThrow(EffectError);
    expect(() => applyEffects(initial, [{ type: "addComponent", component: { id: "app", type: "application" } }])).toThrow(/already exists/);
    expect(() => applyEffects(initial, [{ type: "disconnect", from: "client", to: "db" }])).toThrow(/No dependency/);
  });
});
