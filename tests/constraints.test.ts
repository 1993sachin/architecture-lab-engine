import { describe, expect, it } from "vitest";
import { checkConstraints, createSimulation } from "../src/index.ts";
import { buildScenario } from "./helpers.ts";

describe("constraints", () => {
  it("checks budget, complexity and metric limits", () => {
    const scenario = buildScenario((definition) => {
      definition.initialState.complexityScore = 5;
      definition.constraints = [
        { id: "budget", kind: "budget", description: "Budget", limit: 500 },
        { id: "team", kind: "complexity", description: "Team", limit: 4 },
        { id: "latency", kind: "metric", description: "Latency", metric: "latency", bound: "max", limit: 1000 },
        { id: "availability", kind: "metric", description: "Availability", metric: "availability", bound: "min", limit: 0.999 },
      ];
    });
    const checks = checkConstraints({ state: scenario.initialState, decisionsTaken: [] });
    expect(checks.map((check) => [check.constraintId, check.satisfied])).toEqual([
      ["budget", false],
      ["team", false],
      ["latency", true],
      ["availability", true],
    ]);
    expect(checks[0]?.message).toBe("Monthly budget exceeded by $339.50 ($839.50 of $500).");
  });

  it("records violation periods as the situation changes", () => {
    const simulation = createSimulation(
      buildScenario((definition) => {
        definition.constraints = [{ id: "availability", kind: "metric", description: "Availability SLO", metric: "availability", bound: "min", limit: 0.99 }];
        definition.events = [
          { id: "outage", title: "Outage", description: "", trigger: { at: 3 }, effects: [{ type: "setHealth", componentId: "db", health: "unhealthy" }] },
          { id: "recovery", title: "Recovery", description: "", trigger: { at: 7 }, effects: [{ type: "setHealth", componentId: "db", health: "healthy" }] },
        ];
      }),
    );
    simulation.runToCompletion();
    const [violation, ...rest] = simulation.getResult().constraintsViolated;
    expect(rest).toEqual([]);
    expect(violation).toMatchObject({ constraintId: "availability", startedAt: 3, endedAt: 7, limit: 0.99 });
    expect(violation?.worstValue).toBeLessThan(0.99);
  });

  it("lets events change constraints during the scenario", () => {
    const simulation = createSimulation(
      buildScenario((definition) => {
        definition.constraints = [{ id: "budget", kind: "budget", description: "Budget", limit: 2000 }];
        definition.events = [
          { id: "cut", title: "Budget cut", description: "", trigger: { at: 5 }, effects: [{ type: "updateConstraint", constraintId: "budget", limit: { set: 500 } }] },
          {
            id: "audit",
            title: "Compliance audit",
            description: "",
            trigger: { at: 6 },
            effects: [
              {
                type: "addConstraint",
                constraint: { id: "encryption", kind: "deadline", description: "Encrypt data at rest", limit: 10, condition: { type: "flag", flag: "encrypted", equals: true } },
              },
            ],
          },
        ];
      }),
    );
    simulation.advance(5);
    expect(simulation.getState().constraints[0]).toMatchObject({ limit: 500 });
    simulation.runToCompletion();
    const violations = simulation.getResult().constraintsViolated;
    expect(violations.map((violation) => [violation.constraintId, violation.startedAt, violation.endedAt])).toEqual([
      ["budget", 5, null],
      ["encryption", 10, null],
    ]);
  });
});
