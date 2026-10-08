import { describe, expect, it } from "vitest";
import { createSimulation, replay } from "../src/index.ts";
import { buildScenario } from "./helpers.ts";

describe("observations", () => {
  it("defaults to every tracked metric, visible", () => {
    const simulation = createSimulation(
      buildScenario((definition) => {
        definition.metrics = ["latency", "errorRate"];
      }),
    );
    expect(simulation.getObservations()).toEqual([
      { id: "latency", label: "Average latency", value: simulation.getState().metrics.latency, text: expect.stringMatching(/^Average latency: [\d.]+ ms$/) },
      { id: "errorRate", label: "Error rate", value: 0, text: "Error rate: 0%" },
    ]);
  });

  it("reveals hidden observations through decisions and records what was known", () => {
    const simulation = createSimulation(
      buildScenario((definition) => {
        definition.observations = [
          { id: "latency", label: "Latency", signal: { kind: "metric", metric: "latency" } },
          { id: "db", label: "Database utilization", signal: { kind: "component", componentId: "db", property: "utilization" }, visible: false },
        ];
        definition.decisions = [
          { id: "look", title: "Look at the database", description: "", immediateEffects: [], complexityImpact: 0, reveals: ["db"], duration: 3 },
        ];
      }),
    );
    const outcome = simulation.chooseDecision("look", { rationale: "Is the database the problem?" });
    if (outcome.status !== "applied") throw new Error(outcome.reason);
    expect(outcome.record.knowledge.map((value) => value.id)).toEqual(["latency"]);
    expect(outcome.record.revealed).toEqual([{ id: "db", label: "Database utilization", value: 0.1, text: "Database utilization: 10%" }]);
    expect(simulation.getObservations().map((value) => value.id)).toEqual(["latency", "db"]);
  });

  it("observes configuration values and flags", () => {
    const simulation = createSimulation(
      buildScenario((definition) => {
        definition.initialState.flags = { tier: "standard" };
        definition.initialState.components[2] = { id: "db", type: "database", configuration: { writeCost: 1.25 } };
        definition.observations = [
          { id: "write-cost", label: "Write cost", signal: { kind: "configuration", componentId: "db", key: "writeCost" } },
          { id: "tier", label: "Database tier", signal: { kind: "flag", flag: "tier" } },
          { id: "missing", label: "Cache size", signal: { kind: "configuration", componentId: "cache", key: "size" } },
        ];
      }),
    );
    expect(simulation.getObservations()).toEqual([
      { id: "write-cost", label: "Write cost", value: 1.25, text: "Write cost: 1.25" },
      { id: "tier", label: "Database tier", value: "standard", text: "Database tier: standard" },
      { id: "missing", label: "Cache size", value: null, text: "Cache size: not available" },
    ]);
  });

  it("formats numeric settings and carries the observation's description", () => {
    const simulation = createSimulation(
      buildScenario((definition) => {
        definition.initialState.components[2] = { id: "db", type: "database", configuration: { share: 0.9, writeCost: 1.25 } };
        definition.observations = [
          { id: "share", label: "Cacheable", signal: { kind: "configuration", componentId: "db", key: "share" }, format: "ratio", description: "How much a cache could serve." },
          { id: "cost", label: "Write cost", signal: { kind: "configuration", componentId: "db", key: "writeCost" }, format: "multiplier" },
        ];
      }),
    );
    expect(simulation.getObservations()).toEqual([
      { id: "share", label: "Cacheable", value: 0.9, text: "Cacheable: 90%", description: "How much a cache could serve." },
      { id: "cost", label: "Write cost", value: 1.25, text: "Write cost: 1.25×" },
    ]);
  });

  it("rejects decisions that reveal unknown observations", () => {
    expect(() =>
      buildScenario((definition) => {
        definition.decisions = [{ id: "look", title: "Look", description: "", immediateEffects: [], complexityImpact: 0, reveals: ["nothing"] }];
      }),
    ).toThrow(/reveals unknown observation "nothing"/);
  });
});

describe("component capacity", () => {
  it("observes what all instances of a component can handle together", () => {
    const simulation = createSimulation(
      buildScenario((definition) => {
        definition.initialState.components[1] = { id: "app", type: "application", capacity: 200, instances: 3 };
        definition.observations = [{ id: "app-capacity", label: "Application capacity", signal: { kind: "component", componentId: "app", property: "capacity" } }];
      }),
    );
    expect(simulation.getObservations()).toEqual([{ id: "app-capacity", label: "Application capacity", value: 600, text: "Application capacity: 600 rps" }]);
  });
});

describe("decision duration", () => {
  const scenario = buildScenario((definition) => {
    definition.decisions = [{ id: "migrate", title: "Migrate", description: "", immediateEffects: [], complexityImpact: 1, duration: 5 }];
    definition.events = [{ id: "spike", title: "Spike", description: "", trigger: { at: 3 }, effects: [{ type: "workload", requestsPerSecond: { set: 150 } }] }];
  });

  it("lets time pass, and events fire, while the team works on a decision", () => {
    const simulation = createSimulation(scenario);
    simulation.chooseDecision("migrate", { rationale: "Needed" });
    expect(simulation.getTime()).toBe(5);
    expect(simulation.getHistory().events.map((event) => event.time)).toEqual([3]);
    expect(simulation.getHistory().actions).toEqual([{ type: "decide", decisionId: "migrate", rationale: "Needed" }]);
  });

  it("replays decisions with a duration exactly", () => {
    const simulation = createSimulation(scenario);
    simulation.chooseDecision("migrate", { rationale: "Needed" });
    simulation.advance(2);
    expect(replay(scenario, simulation.getHistory().actions).getHistory()).toEqual(simulation.getHistory());
  });
});
