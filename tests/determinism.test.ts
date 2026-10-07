import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createScenario, createSimulation, replay, trafficSpikeScenario, type Simulation } from "../src/index.ts";

function play(): Simulation {
  const simulation = createSimulation(createScenario(trafficSpikeScenario));
  simulation.advance(5);
  simulation.chooseDecision("scale-application", { rationale: "Application CPU is saturated." });
  simulation.chooseDecision("enable-cache", { rationale: "Reads dominate; offload the database." });
  simulation.advance(3);
  simulation.chooseDecision("enable-rate-limiting", { rationale: "Protect the backend from the excess." });
  simulation.runToCompletion();
  return simulation;
}

describe("determinism", () => {
  it("produces exactly the same result for the same scenario and decisions", () => {
    const first = play();
    const second = play();
    expect(second.getResult()).toEqual(first.getResult());
    expect(second.getHistory()).toEqual(first.getHistory());
    expect(JSON.stringify(second.getResult())).toBe(JSON.stringify(first.getResult()));
  });

  it("reproduces a run from its recorded actions", () => {
    const original = play();
    const replayed = replay(createScenario(trafficSpikeScenario), original.getHistory().actions);
    expect(replayed.getResult()).toEqual(original.getResult());
  });

  it("does not let one simulation affect another or the scenario", () => {
    const scenario = createScenario(trafficSpikeScenario);
    const snapshot = structuredClone(scenario.initialState);
    const a = createSimulation(scenario);
    a.advance(5);
    a.chooseDecision("enable-cache", { rationale: "Test" });
    const b = createSimulation(scenario);
    expect(b.getState()).toEqual(snapshot);
    expect(scenario.initialState).toEqual(snapshot);
    expect(Object.isFrozen(scenario.initialState)).toBe(true);
  });

  it("does not use wall-clock time or unseeded randomness", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : [path];
      });
    for (const file of files(join(import.meta.dirname, "..", "src"))) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/Math\.random|Date\.now|new Date\(|performance\.now/);
    }
  });
});
