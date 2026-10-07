import { describe, expect, it } from "vitest";
import {
  COMPONENT_CATALOG,
  COMPONENT_TYPES,
  ScenarioValidationError,
  createComponent,
  dependenciesOf,
  dependentsOf,
  effectiveCapacity,
  topologicalOrder,
} from "../src/index.ts";
import { buildScenario } from "./helpers.ts";

describe("components", () => {
  it("has a catalog entry for every component type", () => {
    for (const type of COMPONENT_TYPES) expect(COMPONENT_CATALOG[type].type).toBe(type);
  });

  it("fills defaults from the catalog and lets specs override them", () => {
    const cache = createComponent({ id: "c", type: "cache", configuration: { hitRate: 0.5 } });
    expect(cache).toMatchObject({ id: "c", label: "Cache", instances: 1, health: "healthy", capacity: 20000 });
    expect(cache.configuration["hitRate"]).toBe(0.5);
    expect(cache.cost.monthly).toBe(182.5);
  });

  it("scales capacity with instances and health", () => {
    const app = createComponent({ id: "a", type: "application", capacity: 100, instances: 4 });
    expect(effectiveCapacity(app)).toBe(400);
    expect(effectiveCapacity({ ...app, health: "degraded" })).toBe(240);
    expect(effectiveCapacity({ ...app, health: "down" })).toBe(0);
    expect(effectiveCapacity(createComponent({ id: "s", type: "objectStorage" }))).toBeNull();
  });
});

describe("dependency graph", () => {
  it("orders callers before callees and knows transitive dependencies", () => {
    const state = buildScenario().initialState;
    expect(topologicalOrder(state.components, state.dependencies)?.map((c) => c.id)).toEqual(["client", "app", "db"]);
    expect(dependenciesOf(state, "client")).toEqual(["app", "db"]);
    expect(dependentsOf(state, "db")).toEqual(["client", "app"]);
  });

  it("rejects cycles, dangling edges and duplicate ids", () => {
    expect(() =>
      buildScenario((definition) => {
        definition.initialState.dependencies.push({ from: "db", to: "app" });
      }),
    ).toThrow(/cycle/);

    try {
      buildScenario((definition) => {
        definition.initialState.components.push({ id: "app", type: "worker" });
        definition.initialState.dependencies.push({ from: "app", to: "nowhere" });
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioValidationError);
      const issues = (error as ScenarioValidationError).issues;
      expect(issues).toContain('Duplicate component id "app".');
      expect(issues.some((issue) => issue.includes('unknown component "nowhere"'))).toBe(true);
    }
  });
});
