import { describe, expect, it } from "vitest";
import { createSimulation, formatUsd, fromHourly, toCost, totalCost } from "../src/index.ts";
import { buildScenario } from "./helpers.ts";

describe("cost model", () => {
  it("derives monthly from hourly and hourly from monthly", () => {
    expect(fromHourly(1)).toEqual({ hourly: 1, monthly: 730 });
    expect(toCost({ monthly: 730 })).toEqual({ hourly: 1, monthly: 730 });
  });

  it("totals every component instance plus additional costs", () => {
    const scenario = buildScenario((definition) => {
      definition.initialState.components[1] = { id: "app", type: "application", instances: 3, cost: { hourly: 0.5 } };
      definition.initialState.components[2] = { id: "db", type: "database", cost: { monthly: 1000 } };
      definition.initialState.additionalCosts = { support: { monthly: 200 } };
    });
    expect(totalCost(scenario.initialState).monthly).toBe(3 * 365 + 1000 + 200);
    expect(scenario.initialState.metrics.monthlyCost).toBe(2295);
  });

  it("formats money deterministically", () => {
    expect(formatUsd(1000)).toBe("$1,000");
    expect(formatUsd(1234567.5)).toBe("$1,234,567.50");
    expect(formatUsd(-12.3)).toBe("-$12.30");
    expect(formatUsd(0)).toBe("$0");
  });

  it("lets decisions change cost through components and through costImpact", () => {
    const scenario = buildScenario((definition) => {
      definition.decisions = [
        {
          id: "scale",
          title: "Scale",
          description: "Add an app instance",
          immediateEffects: [{ type: "updateComponent", componentId: "app", instances: { add: 1 } }],
          complexityImpact: 0,
          repeatable: true,
        },
        {
          id: "support",
          title: "Buy support",
          description: "Vendor support plan",
          immediateEffects: [],
          costImpact: { monthly: 500 },
          complexityImpact: 0,
          repeatable: true,
        },
      ];
    });
    const simulation = createSimulation(scenario);
    const start = simulation.getState().metrics.monthlyCost ?? 0;

    const preview = simulation.previewDecision("scale");
    expect(preview?.costDelta.monthly).toBe(109.5);

    simulation.chooseDecision("scale", { rationale: "More capacity" });
    simulation.chooseDecision("support", { rationale: "Faster incident response" });
    simulation.chooseDecision("support", { rationale: "Second plan" });
    const state = simulation.getState();
    expect(state.additionalCosts["decision:support"]?.monthly).toBe(1000);
    expect(state.metrics.monthlyCost).toBe(start + 109.5 + 1000);
  });

  it("accumulates spend over logical time", () => {
    const simulation = createSimulation(buildScenario());
    simulation.runToCompletion();
    const result = simulation.getResult();
    const expected = (result.metrics.totalCost * 30) / (730 * 60);
    expect(result.metrics.spend).toBe(Math.round(expected * 100) / 100);
  });
});
