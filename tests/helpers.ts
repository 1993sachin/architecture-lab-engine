import { createScenario, type Scenario, type ScenarioDefinition } from "../src/index.ts";

/**
 * A small system for focused tests: client → app → db, 100 rps, 80% reads.
 * Pass a function to adjust the definition before it is validated.
 */
export function baseDefinition(): ScenarioDefinition {
  return {
    id: "test",
    title: "Test scenario",
    workload: { requestsPerSecond: 100, readRatio: 0.8 },
    initialState: {
      components: [
        { id: "client", type: "client" },
        { id: "app", type: "application", capacity: 200, instances: 1 },
        { id: "db", type: "database", capacity: 1000 },
      ],
      dependencies: [
        { from: "client", to: "app" },
        { from: "app", to: "db", traffic: "read" },
        { from: "app", to: "db", traffic: "write" },
      ],
    },
    decisions: [],
    objectives: [{ id: "no-errors", description: "No errors", condition: { type: "metric", metric: "errorRate", op: "<=", value: 0.01 } }],
    completion: { maxDuration: 30 },
  };
}

export function buildScenario(adjust: (definition: ScenarioDefinition) => void = () => {}): Scenario {
  const definition = baseDefinition();
  adjust(definition);
  return createScenario(definition);
}

export function component<T extends { components: { id: string }[] }>(state: T, id: string): T["components"][number] {
  const found = state.components.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No component ${id}`);
  return found;
}
