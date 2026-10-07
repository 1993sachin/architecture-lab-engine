import { describe, expect, it } from "vitest";
import { SimulationError, createSimulation, formatTime } from "../src/index.ts";
import { buildScenario } from "./helpers.ts";

const withEvents = () =>
  buildScenario((definition) => {
    definition.events = [
      { id: "spike", title: "Spike", description: "Traffic doubles", trigger: { at: 3 }, effects: [{ type: "workload", requestsPerSecond: { multiply: 2 } }] },
      {
        id: "db-sick",
        title: "Database degrades",
        description: "Fires once traffic is high",
        trigger: { when: { type: "workload", property: "requestsPerSecond", op: ">=", value: 200 } },
        effects: [{ type: "setHealth", componentId: "db", health: "degraded" }],
      },
    ];
  });

describe("logical time", () => {
  it("starts at T+0 and moves only when advanced", () => {
    const simulation = createSimulation(buildScenario());
    expect(simulation.getTime()).toBe(0);
    expect(simulation.getState().time).toBe(0);
    simulation.advance();
    simulation.advance(4);
    expect(simulation.getTime()).toBe(5);
  });

  it("formats logical time", () => {
    expect(formatTime(0)).toBe("T+0");
    expect(formatTime(10)).toBe("T+10 min");
  });

  it("fires events at their logical time, once, in order", () => {
    const simulation = createSimulation(withEvents());
    expect(simulation.advance(2).events).toEqual([]);
    const report = simulation.advance(1);
    expect(report.events.map((event) => [event.eventId, event.time])).toEqual([["spike", 3]]);
    // The conditional event sees the new traffic at the next tick.
    expect(simulation.advance(1).events.map((event) => event.eventId)).toEqual(["db-sick"]);
    simulation.advance(5);
    expect(simulation.getHistory().events.map((event) => event.eventId)).toEqual(["spike", "db-sick"]);
    expect(simulation.getState().workload.requestsPerSecond).toBe(200);
  });

  it("gives the same state whether advanced in one step or tick by tick", () => {
    const coarse = createSimulation(withEvents());
    coarse.advance(10);
    const fine = createSimulation(withEvents());
    for (let i = 0; i < 10; i++) fine.advance(1);
    expect(fine.getState()).toEqual(coarse.getState());
    expect(fine.getHistory().samples).toEqual(coarse.getHistory().samples);
  });

  it("supports larger time steps", () => {
    const simulation = createSimulation(
      buildScenario((definition) => {
        definition.timeStep = 5;
      }),
    );
    simulation.advance();
    expect(simulation.getTime()).toBe(5);
    expect(() => simulation.advance(3)).toThrow(SimulationError);
  });

  it("stops at the scenario's duration and refuses to go further", () => {
    const simulation = createSimulation(buildScenario());
    const report = simulation.advance(100);
    expect(report.to).toBe(30);
    expect(report.complete).toBe(true);
    expect(simulation.isComplete()).toBe(true);
    expect(() => simulation.advance()).toThrow(/ended/);
    expect(simulation.validateDecision("anything")).toMatchObject({ status: "unavailable", reason: "The scenario has ended." });
  });

  it("can end early on a condition, or fail on one", () => {
    const ended = createSimulation(
      buildScenario((definition) => {
        definition.completion.endWhen = { type: "time", op: ">=", value: 4 };
      }),
    );
    ended.runToCompletion();
    expect(ended.getResult()).toMatchObject({ endReason: "endCondition", duration: 4 });

    const failed = createSimulation(
      buildScenario((definition) => {
        definition.events = [{ id: "outage", title: "Outage", description: "Database dies", trigger: { at: 2 }, effects: [{ type: "setHealth", componentId: "db", health: "down" }] }];
        definition.completion.failWhen = { type: "metric", metric: "availability", op: "<", value: 0.5 };
      }),
    );
    failed.runToCompletion();
    expect(failed.getResult()).toMatchObject({ endReason: "failCondition", outcome: "failure", duration: 2 });
  });

  it("applies events scheduled for T+0 to the starting state", () => {
    const simulation = createSimulation(
      buildScenario((definition) => {
        definition.events = [{ id: "start", title: "Start", description: "Busy morning", trigger: { at: 0 }, effects: [{ type: "workload", requestsPerSecond: { set: 150 } }] }];
      }),
    );
    expect(simulation.getState().metrics.requestsPerSecond).toBe(150);
  });
});
