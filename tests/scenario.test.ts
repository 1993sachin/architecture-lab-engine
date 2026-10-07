import { describe, expect, it } from "vitest";
import { ScenarioValidationError, createScenario, createSimulation, defineScenario, trafficSpikeScenario } from "../src/index.ts";
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

describe("The 10× Traffic Incident", () => {
  const scenario = createScenario(trafficSpikeScenario);

  it("starts healthy", () => {
    const { metrics } = scenario.initialState;
    expect(metrics.requestsPerSecond).toBe(300);
    expect(metrics.errorRate).toBe(0);
    expect(metrics.p95Latency).toBeLessThan(100);
    expect(metrics.monthlyCost).toBe(1262.9);
  });

  it("overloads the application when traffic jumps tenfold", () => {
    const simulation = createSimulation(scenario);
    simulation.advance(5);
    const { metrics } = simulation.getState();
    expect(metrics.requestsPerSecond).toBe(3000);
    expect(metrics.cpuUtilization).toBe(3.75);
    expect(metrics.errorRate).toBeGreaterThan(0.5);
  });

  it("shows that scaling the application alone moves the bottleneck to the database", () => {
    const simulation = createSimulation(scenario);
    simulation.advance(5);
    simulation.chooseDecision("scale-application", { rationale: "CPU is saturated." });
    simulation.chooseDecision("scale-application", { rationale: "Still saturated." });
    const { metrics } = simulation.getState();
    expect(metrics.cpuUtilization).toBe(1.25);
    expect(metrics.databaseUtilization).toBeGreaterThan(2);
  });

  it("blocks scaling beyond the budget", () => {
    const simulation = createSimulation(scenario);
    for (let i = 0; i < 3; i++) expect(simulation.chooseDecision("scale-application", { rationale: "More" }).status).toBe("applied");
    expect(simulation.chooseDecision("scale-application", { rationale: "More" })).toMatchObject({
      status: "unavailable",
      reason: "Monthly budget would be exceeded by $14.90.",
    });
  });

  it("recovers with scale-out, a cache and rate limiting", () => {
    const simulation = createSimulation(scenario);

    // T+0 → T+5: the spike hits.
    simulation.advance(5);
    const peak = simulation.getState().metrics;

    // Respond.
    simulation.chooseDecision("scale-application", { rationale: "Application CPU is at 375%." });
    simulation.chooseDecision("scale-application", { rationale: "Still above capacity." });
    simulation.chooseDecision("enable-cache", { rationale: "80% of traffic is reads and the database is now the bottleneck." });
    simulation.advance(2);
    simulation.chooseDecision("enable-rate-limiting", { rationale: "Shed excess load instead of failing everyone." });

    // Let the scenario play out: eviction storm, budget cut, traffic settling.
    simulation.runToCompletion();
    const result = simulation.getResult();
    const final = result.finalState.metrics;

    expect(result).toMatchObject({ outcome: "success", complete: true, endReason: "maxDuration", duration: 45 });
    expect(final.errorRate).toBe(0);
    expect(final.p95Latency).toBeLessThan(peak.p95Latency ?? 0);
    expect(final.databaseUtilization).toBeLessThanOrEqual(0.8);
    expect(result.objectives.every((objective) => objective.met)).toBe(true);
    expect(result.metrics.peakErrorRate).toBeGreaterThan(0.5);
    expect(result.metrics.totalCost).toBe(2321.4);
    expect(result.metrics.finalComplexity).toBe(7);
    expect(result.decisions.map((record) => [record.decisionId, record.timestamp])).toEqual([
      ["scale-application", 5],
      ["scale-application", 5],
      ["enable-cache", 5],
      ["enable-rate-limiting", 7],
    ]);
    expect(simulation.getHistory().events.map((event) => [event.eventId, event.time])).toEqual([
      ["traffic-spike", 5],
      ["cache-eviction", 20],
      ["budget-cut", 25],
      ["traffic-settles", 35],
    ]);
    expect(result.constraintsViolated.map((violation) => violation.constraintId)).toEqual(["latency-slo", "availability-slo"]);
    expect(result.constraintsViolated.every((violation) => violation.endedAt !== null)).toBe(true);
    expect(result.strengths).toContain("Every decision was recorded with a rationale.");
    expect(result.weaknesses).toContain("Error rate peaked at 87.08% at T+5 min.");
  });

  it("fails when nothing is done", () => {
    const simulation = createSimulation(scenario);
    simulation.runToCompletion();
    const result = simulation.getResult();
    expect(result.outcome).toBe("failure");
    expect(result.weaknesses).toContain("No decisions were taken.");
  });
});
