/**
 * Phase 1.5 stress test: can the engine produce meaningfully different outcomes
 * from different reasonable strategies? See docs/phase-1.5-stress-test.md.
 */
import { describe, expect, it } from "vitest";
import { createScenario, createSimulation, replay, trafficSpikeScenario, type SimulationAction } from "../src/index.ts";
import { STRATEGIES, play, summarize, toActions, type StrategySummary } from "./support/strategies.ts";

const scenario = createScenario(trafficSpikeScenario);
const summaries = Object.fromEntries(STRATEGIES.map((strategy) => [strategy.id, summarize(strategy, play(strategy, scenario))])) as Record<
  "A" | "B" | "C" | "D" | "E",
  StrategySummary
>;

/** Lower is better on every dimension compared. */
const DIMENSIONS = ["failedRequests", "minutesInViolation", "peakP95", "finalMonthlyCost", "spend", "complexity"] as const;

function dominates(a: StrategySummary, b: StrategySummary): boolean {
  return DIMENSIONS.every((key) => a[key] <= b[key]) && DIMENSIONS.some((key) => a[key] < b[key]);
}

describe("strategy comparison", () => {
  it("gives each strategy a distinct outcome profile", () => {
    expect(Object.values(summaries).map((summary) => [summary.id, summary.outcome])).toEqual([
      ["A", "failure"],
      ["B", "partial"],
      ["C", "success"],
      ["D", "failure"],
      ["E", "partial"],
    ]);
  });

  it("has no strategy that dominates all others", () => {
    for (const candidate of Object.values(summaries)) {
      const others = Object.values(summaries).filter((other) => other.id !== candidate.id);
      expect(others.every((other) => dominates(candidate, other)), `${candidate.name} dominates`).toBe(false);
    }
  });

  it("keeps genuine trade-offs between the better strategies", () => {
    const { A, B, C, E } = summaries;
    // Cache first wins overall and is cheapest to run afterwards...
    expect(C.score).toBeGreaterThan(B.score);
    expect(C.finalMonthlyCost).toBeLessThan(B.finalMonthlyCost);
    // ...but investigating first and spreading reads fails fewer users, at the price of complexity.
    expect(B.failedRequests).toBeLessThan(C.failedRequests);
    expect(B.complexity).toBeGreaterThan(C.complexity);
    // Scaling first reacts fastest and stays simplest, but never fixes the database.
    expect(A.peakErrorRate).toBeLessThan(C.peakErrorRate);
    expect(A.complexity).toBeLessThan(C.complexity);
    expect(A.stabilizedAt).toBeNull();
    // A rate limit keeps latency low by turning users away.
    expect(E.throttledRequests).toBeGreaterThan(0);
    expect(E.failedRequests).toBeGreaterThan(B.failedRequests);
  });
});

describe("decision timing", () => {
  const scaleOut = Array.from({ length: 4 }, (): SimulationAction => ({ type: "decide", decisionId: "scale-application", rationale: "Match capacity" }));
  const cache: SimulationAction = { type: "decide", decisionId: "enable-cache", rationale: "Offload reads" };
  const run = (actions: SimulationAction[]) => {
    const simulation = replay(scenario, actions);
    simulation.runToCompletion();
    return simulation.getResult();
  };

  it("rewards a cache added before the spike: it is warm when traffic arrives", () => {
    const early = run([{ type: "advance", minutes: 2 }, cache, { type: "advance", minutes: 4 }, ...scaleOut]);
    const onTime = run([{ type: "advance", minutes: 6 }, cache, ...scaleOut]);
    const late = run([{ type: "advance", minutes: 6 }, ...scaleOut, { type: "advance", minutes: 2 }, cache]);
    expect(early.impact.failedRequests).toBeLessThan(onTime.impact.failedRequests);
    expect(onTime.impact.failedRequests).toBeLessThan(late.impact.failedRequests);
    expect(early.metrics.availability).toBeGreaterThan(late.metrics.availability);
  });

  it("charges the time spent investigating while the incident unfolds", () => {
    expect(summaries.B.peakErrorRate).toBe(1);
    expect(summaries.A.peakErrorRate).toBeLessThan(1);
  });
});

describe("investigation", () => {
  it("reveals information without changing the system", () => {
    const investigated = createSimulation(scenario);
    const waited = createSimulation(scenario);
    const hidden = investigated.getObservations().map((observation) => observation.id);
    expect(hidden).not.toContain("read-ratio");

    const outcome = investigated.chooseDecision("investigate-traffic", { rationale: "Find out what the traffic is." });
    waited.advance(2);

    expect(investigated.getTime()).toBe(2);
    expect(investigated.getState()).toEqual(waited.getState());
    expect(outcome.status === "applied" && outcome.record.revealed.map((value) => value.text)).toEqual([
      "Traffic mix: reads are 80% of traffic, writes 20%",
    ]);
    expect(investigated.getObservations().map((observation) => observation.id)).toContain("read-ratio");
    expect(waited.getObservations().map((observation) => observation.id)).not.toContain("read-ratio");
  });
});

describe("delayed consequences", () => {
  it("lets asynchronous writes look like a fix until the queue fills up", () => {
    const simulation = createSimulation(scenario);
    simulation.advance(6);
    for (let i = 0; i < 4; i++) simulation.chooseDecision("scale-application", { rationale: "Match capacity" });
    simulation.chooseDecision("enable-cache", { rationale: "Offload reads" });
    simulation.chooseDecision("enable-async-processing", { rationale: "Take writes off the request path" });

    const errors: number[] = [];
    for (let i = 0; i < 8; i++) errors.push(simulation.advance(1).state.metrics.errorRate ?? 0);
    const recovered = errors.indexOf(0);
    expect(recovered).toBeGreaterThan(-1);
    // Later, the queue is full and writes are rejected.
    expect(errors[errors.length - 1]).toBeGreaterThan(0.05);
    expect(simulation.getState().metrics.queueDepth).toBe(100000);
  });

  it("lets aggressive scaling look affordable until the budget is cut", () => {
    const violation = (id: string) =>
      play(STRATEGIES.find((strategy) => strategy.id === id)!, scenario)
        .getResult()
        .constraintsViolated.find((candidate) => candidate.constraintId === "budget");
    expect(violation("A")).toMatchObject({ startedAt: 25, endedAt: null });
    expect(violation("C")).toMatchObject({ startedAt: 25, endedAt: 36 });
  });
});

describe("constraints in outcomes", () => {
  it("does not call a strategy successful when latency stayed above the SLO for most of the run", () => {
    const result = play(STRATEGIES.find((strategy) => strategy.id === "B")!, scenario).getResult();
    expect(result.objectives.find((objective) => objective.objectiveId === "responsive")).toMatchObject({ met: false });
    expect(result.outcome).not.toBe("success");
  });

  it("does not call a strategy successful when it protects the system by rejecting users", () => {
    const simulation = createSimulation(scenario);
    simulation.advance(3);
    simulation.chooseDecision("enable-rate-limiting", { rationale: "Shed load" });
    for (let i = 0; i < 2; i++) simulation.chooseDecision("scale-application", { rationale: "Capacity behind the limit" });
    simulation.chooseDecision("enable-cache", { rationale: "Offload reads" });
    simulation.runToCompletion();
    const result = simulation.getResult();
    expect(result.impact.throttledRequests).toBeGreaterThan(500000);
    expect(result.objectives.find((objective) => objective.objectiveId === "users-served")?.met).toBe(false);
    expect(result.outcome).not.toBe("success");
  });
});

describe("determinism of every strategy", () => {
  it.each(STRATEGIES.map((strategy) => [strategy.name, strategy] as const))("%s replays identically three times", (_name, strategy) => {
    const runs = [1, 2, 3].map(() => play(strategy, scenario));
    const [first, ...rest] = runs.map((simulation) => JSON.stringify({ history: simulation.getHistory(), result: simulation.getResult() }));
    for (const other of rest) expect(other).toBe(first);
  });
});

describe("counterfactuals", () => {
  it("compares two runs that differ in exactly one decision", () => {
    const original = STRATEGIES.find((strategy) => strategy.id === "A")!;
    const actions = toActions(original.steps, scenario);
    const changed = actions.map((action) =>
      action.type === "decide" && action.decisionId === "increase-database-capacity"
        ? { ...action, decisionId: "enable-cache", rationale: "Counterfactual: cache instead of a bigger database." }
        : action,
    );
    expect(changed.filter((action, index) => JSON.stringify(action) !== JSON.stringify(actions[index]))).toHaveLength(1);

    const run = (list: SimulationAction[]) => {
      const simulation = replay(scenario, list);
      if (!simulation.isComplete()) simulation.runToCompletion();
      return simulation.getResult();
    };
    const factual = run(actions);
    const counterfactual = run(changed);
    expect(counterfactual.duration).toBe(factual.duration);
    expect(counterfactual.impact.failedRequests).toBeLessThan(factual.impact.failedRequests);
    expect(counterfactual.metrics.totalCost).toBeLessThan(factual.metrics.totalCost);
    expect(counterfactual.metrics.finalComplexity).toBeGreaterThan(factual.metrics.finalComplexity);
  });
});

describe("decision rationale", () => {
  it("keeps what was known, why, and what happened for every decision", () => {
    const simulation = play(STRATEGIES.find((strategy) => strategy.id === "B")!, scenario);
    const records = simulation.getHistory().decisions;
    for (const record of records) {
      expect(record.rationale.length).toBeGreaterThan(0);
      expect(record.knowledge.length).toBeGreaterThan(0);
      expect(record.stateBefore.time).toBe(record.timestamp);
      expect(record.stateAfter.time).toBe(record.timestamp);
    }
    const cache = records.find((record) => record.decisionId === "enable-cache")!;
    expect(cache.rationale).toBe("80% of requests are reads and the database is saturated.");
    expect(cache.knowledge.map((value) => value.id)).toEqual(expect.arrayContaining(["read-ratio", "database-utilization"]));
    expect(cache.consequences.map((consequence) => consequence.description)).toContain("Added Redis (cache, 1 instance).");

    const first = records[0]!;
    expect(first.knowledge.map((value) => value.id)).not.toContain("read-ratio");
  });
});
