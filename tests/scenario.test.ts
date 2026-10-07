import { describe, expect, it } from "vitest";
import { ScenarioValidationError, createScenario, createSimulation, defineScenario } from "../src/index.ts";
import { baseDefinition } from "./helpers.ts";

describe("scenario definition", () => {
  it("validates and reports every problem at once", () => {
    const definition = baseDefinition();
    definition.workload.readRatio = 2;
    definition.completion.maxDuration = 0;
    definition.objectives.push({ id: "no-errors", description: "Again", condition: { type: "metric", metric: "nonsense" as never, op: "<", value: 1 } });
    try {
      createScenario(definition);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioValidationError);
      expect((error as ScenarioValidationError).issues).toEqual([
        "workload.readRatio must be between 0 and 1.",
        'Duplicate objective id "no-errors".',
        'Objective "no-errors" uses unknown metric "nonsense".',
        "completion.maxDuration must be a positive whole number of minutes.",
      ]);
    }
  });

  it("copies the definition so later edits do not leak in", () => {
    const definition = defineScenario(baseDefinition());
    const scenario = createScenario(definition);
    definition.workload.requestsPerSecond = 9999;
    expect(scenario.initialState.workload.requestsPerSecond).toBe(100);
  });
});

describe("objectives over time", () => {
  it("measures how much of the run an objective held", () => {
    const simulation = createSimulation(
      createScenario({
        ...baseDefinition(),
        objectives: [
          {
            id: "mostly-fine",
            description: "Error rate under 1% for 80% of the time",
            condition: { type: "metric", metric: "errorRate", op: "<=", value: 0.01 },
            evaluation: "fractionOfTime",
            threshold: 0.8,
          },
        ],
        events: [
          { id: "outage", title: "Outage", description: "", trigger: { at: 21 }, effects: [{ type: "setHealth", componentId: "db", health: "down" }] },
        ],
      }),
    );
    simulation.runToCompletion();
    const [objective] = simulation.getResult().objectives;
    // Fine for 20 of 30 minutes.
    expect(objective).toMatchObject({ met: false, achieved: 0.6667, firstFailedAt: 21 });
  });

  it("requires a threshold for fraction-of-time objectives", () => {
    const definition = baseDefinition();
    definition.objectives[0]!.evaluation = "fractionOfTime";
    expect(() => createScenario(definition)).toThrow(/needs a threshold/);
  });
});

describe("incident impact", () => {
  it("counts failed and throttled requests, violation minutes and stabilization", () => {
    const definition = baseDefinition();
    definition.initialState.components.push({ id: "gw", type: "apiGateway", configuration: { rateLimit: 50 } });
    definition.initialState.dependencies[0] = { from: "client", to: "gw" };
    definition.initialState.dependencies.push({ from: "gw", to: "app" });
    definition.constraints = [{ id: "slo", kind: "metric", description: "Availability", metric: "availability", bound: "min", limit: 0.99 }];
    definition.events = [
      { id: "fix", title: "Limit lifted", description: "", trigger: { at: 10 }, effects: [{ type: "configure", componentId: "gw", key: "rateLimit", value: 0 }] },
    ];
    const simulation = createSimulation(createScenario(definition));
    simulation.runToCompletion();
    const { impact } = simulation.getResult();
    // 50 of 100 rps rejected for 9 minutes (T+1..T+9).
    expect(impact).toEqual({
      totalRequests: 180000,
      successfulRequests: 153000,
      failedRequests: 0,
      throttledRequests: 27000,
      businessImpact: null,
      minutesInViolation: 9,
      sloViolationMinutes: 9,
      violationMinutes: { slo: 9 },
      compliance: 0.7,
      stabilizedAt: 10,
    });
  });
});
