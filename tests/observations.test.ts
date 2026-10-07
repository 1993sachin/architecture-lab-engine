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

  it("rejects decisions that reveal unknown observations", () => {
    expect(() =>
      buildScenario((definition) => {
        definition.decisions = [{ id: "look", title: "Look", description: "", immediateEffects: [], complexityImpact: 0, reveals: ["nothing"] }];
      }),
    ).toThrow(/reveals unknown observation "nothing"/);
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
