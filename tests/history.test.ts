import { describe, expect, it } from "vitest";
import { createScenario, createSimulation, trafficIncidentScenario } from "../src/index.ts";

describe("decision history", () => {
  it("records each decision with its rationale, timestamp and before/after state", () => {
    const simulation = createSimulation(createScenario(trafficIncidentScenario));
    simulation.advance(3);
    const rationale = "Read traffic is dominant and database latency is increasing.";
    const outcome = simulation.chooseDecision("enable-cache", { rationale });
    expect(outcome.status).toBe("applied");

    const [record] = simulation.getHistory().decisions;
    expect(record).toMatchObject({ sequence: 1, decisionId: "enable-cache", title: "Add a Redis cache", timestamp: 3, rationale });
    expect(record?.stateBefore.components.map((c) => c.id)).not.toContain("cache");
    expect(record?.stateAfter.components.map((c) => c.id)).toContain("cache");
    expect(record?.stateAfter.metrics.databaseUtilization).toBeLessThan(record?.stateBefore.metrics.databaseUtilization ?? 0);
  });

  it("describes consequences with direction and severity", () => {
    const simulation = createSimulation(createScenario(trafficIncidentScenario));
    simulation.advance(3);
    const outcome = simulation.chooseDecision("enable-cache", { rationale: "Offload reads" });
    if (outcome.status !== "applied") throw new Error(outcome.reason);
    const bySubject = new Map(outcome.record.consequences.map((c) => [JSON.stringify(c.subject), c]));

    expect(bySubject.get(JSON.stringify({ kind: "component", componentId: "cache", change: "added" }))?.description).toBe(
      "Added Redis (cache, 1 instance).",
    );
    expect(bySubject.get(JSON.stringify({ kind: "complexity" }))).toMatchObject({ before: 3, after: 6, delta: 3, impact: "negative" });
    expect(bySubject.get(JSON.stringify({ kind: "metric", metric: "monthlyCost" }))).toMatchObject({ delta: 255.5, impact: "negative" });
    expect(bySubject.get(JSON.stringify({ kind: "metric", metric: "databaseUtilization" }))?.impact).toBe("positive");
    expect(bySubject.get(JSON.stringify({ kind: "metric", metric: "cacheHitRate" }))?.description).toBe("Cache hit rate is now measured: 20%.");
  });

  it("attributes consequences of time passing to events and ongoing effects", () => {
    const simulation = createSimulation(createScenario(trafficIncidentScenario));
    const report = simulation.advance(5);
    const latency = report.consequences.find((c) => c.subject.kind === "metric" && c.subject.metric === "p99Latency");
    expect(latency).toMatchObject({
      impact: "negative",
      severity: "critical",
      source: { kind: "progression", from: 0, to: 5, causes: ["event:launch-goes-viral", "ongoing:launch-goes-viral/first-wave"] },
    });
  });

  it("keeps a chronological log of decisions, events, rejections and progress", () => {
    const simulation = createSimulation(createScenario(trafficIncidentScenario));
    simulation.advance(5);
    simulation.chooseDecision("scale-application", { rationale: "More capacity" });
    simulation.chooseDecision("scale-down-application", { rationale: "Too early" });
    simulation.advance(1);
    const history = simulation.getHistory();
    // The scenario's constraints are logged as they become active, at T+0.
    expect(history.entries.map((entry) => entry.type)).toEqual([
      ...Array(4).fill("constraint"),
      "event",
      "advance",
      "decision",
      "rejectedDecision",
      "advance",
    ]);
    expect(history.samples.map((sample) => sample.time)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(history.actions).toEqual([
      { type: "advance", minutes: 5 },
      { type: "decide", decisionId: "scale-application", rationale: "More capacity" },
      { type: "decide", decisionId: "scale-down-application", rationale: "Too early" },
      { type: "advance", minutes: 1 },
    ]);
  });

  it("hands out copies, so callers cannot change the simulation", () => {
    const simulation = createSimulation(createScenario(trafficIncidentScenario));
    const state = simulation.getState();
    state.workload.requestsPerSecond = 1;
    simulation.getHistory().samples.length = 0;
    expect(simulation.getState().workload.requestsPerSecond).toBe(10000);
    expect(simulation.getHistory().samples).toHaveLength(1);
  });
});
