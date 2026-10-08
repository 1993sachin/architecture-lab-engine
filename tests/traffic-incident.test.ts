/**
 * Scenario-level tests for "The 10× Traffic Incident": each mechanic the
 * scenario relies on, whole-incident scoring, the playbooks, replay and
 * counterfactuals.
 */
import { describe, expect, it } from "vitest";
import {
  createScenario,
  createSimulation,
  playbookActions,
  replay,
  trafficIncidentPlaybooks,
  trafficIncidentScenario,
  type Simulation,
  type SimulationAction,
} from "../src/index.ts";
import { component } from "./helpers.ts";
import { allPlans, explore, PARETO_KEYS } from "./support/landscape.ts";
import { STRATEGIES, play, summarize, toActions, type Strategy } from "./support/strategies.ts";

const scenario = createScenario(trafficIncidentScenario);

function at(minute: number, decisions: string[] = []): Simulation {
  const simulation = createSimulation(scenario);
  if (minute > 0) simulation.advance(minute);
  for (const decisionId of decisions) {
    const outcome = simulation.chooseDecision(decisionId, { rationale: "test" });
    if (outcome.status !== "applied") throw new Error(`${decisionId}: ${outcome.reason}`);
  }
  return simulation;
}

function strategy(id: string): Strategy {
  const found = STRATEGIES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No strategy ${id}`);
  return found;
}

describe("starting point", () => {
  it("matches the brief: 10K rps, 30K app capacity, PostgreSQL at ~70%, p99 ~180 ms, 0.1% errors", () => {
    const state = scenario.initialState;
    expect(state.metrics.requestsPerSecond).toBe(10000);
    expect(state.metrics.cpuUtilization).toBe(0.3333);
    expect(component(state, "app").capacity! * component(state, "app").instances).toBe(30000);
    expect(component(state, "db").capacity).toBe(15000);
    expect(state.metrics.databaseUtilization).toBeCloseTo(0.7, 2);
    expect(state.metrics.p99Latency).toBeCloseTo(180, -1);
    expect(state.metrics.errorRate).toBe(0.001);
    expect(state.metrics.monthlyCost).toBe(1861.5);
  });

  it("shows only headline metrics until someone investigates", () => {
    const visible = createSimulation(scenario).getObservations().map((value) => value.id);
    expect(visible).toContain("p99-latency");
    expect(visible).not.toContain("read-ratio");
    expect(visible).not.toContain("database-cpu");
    expect(visible).not.toContain("cacheable-reads");
    expect(visible).not.toContain("write-cost");
  });
});

describe("traffic ramp", () => {
  it("climbs from T+3 to ~50K by T+6 and ~100K by T+13, then settles at 30K", () => {
    const simulation = createSimulation(scenario);
    simulation.runToCompletion();
    const rate = (minute: number) => simulation.getHistory().samples.find((sample) => sample.time === minute)?.metrics.requestsPerSecond;
    expect([2, 3, 4, 5, 6].map(rate)).toEqual([10000, 15000, 27000, 39000, 50000]);
    expect([8, 9, 13, 22].map(rate)).toEqual([50000, 60000, 100000, 100000]);
    expect([29, 45].map(rate)).toEqual([30000, 30000]);
  });

  it("is overwhelmingly reads, which only an investigation shows", () => {
    const simulation = at(3);
    expect(simulation.getState().workload.readRatio).toBe(0.94);
    const outcome = simulation.chooseDecision("investigate-traffic", { rationale: "What is this traffic?" });
    if (outcome.status !== "applied") throw new Error(outcome.reason);
    expect(outcome.record.revealed.map((value) => [value.id, value.value])).toEqual([
      ["read-ratio", 0.94],
      ["cacheable-reads", 0.9],
    ]);
  });
});

describe("the database becomes the bottleneck", () => {
  it("saturates before the application does", () => {
    const { metrics } = at(3).getState();
    expect(metrics.cpuUtilization).toBe(0.5);
    expect(metrics.databaseUtilization).toBeGreaterThan(1);
  });

  it("charges writes more than reads", () => {
    const db = component(scenario.initialState, "db");
    expect(db.configuration).toMatchObject({ readCost: 1, writeCost: 1.25 });
    // 8,000 reads + 2,000 writes × 1.25 = 10,500 of 15,000 (slightly less: 0.1% of requests fail earlier).
    expect(db.utilization).toBeCloseTo(0.7, 2);
  });
});

describe("scaling the application", () => {
  it("adds capacity and cost but pushes the failure down to PostgreSQL", () => {
    const before = at(6).getState();
    const after = at(6, ["scale-application", "scale-application"]).getState();
    expect(component(after, "app").instances).toBe(14);
    expect(after.metrics.cpuUtilization).toBeLessThan(1);
    expect(after.metrics.monthlyCost).toBe((before.metrics.monthlyCost ?? 0) + 8 * 73);
    expect(after.metrics.databaseUtilization).toBeGreaterThan(before.metrics.databaseUtilization ?? 0);
    expect(after.metrics.errorRate).toBeGreaterThan(0.5);
  });

  it("becomes waste once traffic settles, and can be trimmed only while CPU allows", () => {
    const simulation = at(6, ["enable-cache", "scale-application", "scale-application"]);
    expect(simulation.chooseDecision("scale-down-application", { rationale: "Too early" }).status).toBe("invalid");
    simulation.advance(30 - simulation.getTime());
    expect(simulation.getState().metrics.cpuUtilization).toBeLessThan(0.5);
    expect(simulation.chooseDecision("scale-down-application", { rationale: "Traffic settled" }).status).toBe("applied");
  });
});

describe("caching", () => {
  it("starts cold, warms towards the cacheable share of reads, and takes reads off PostgreSQL", () => {
    const simulation = at(8, ["enable-cache"]);
    const hitRates = [simulation.getState().metrics.cacheHitRate];
    for (let minute = 0; minute < 6; minute++) hitRates.push(simulation.advance(1).state.metrics.cacheHitRate);
    expect(hitRates).toEqual([0.2, 0.34, 0.48, 0.62, 0.76, 0.9, 0.9]);
    expect(simulation.getState().metrics.databaseUtilization).toBeLessThan(0.6);
  });

  it("costs money and complexity and makes reads slightly stale", () => {
    const outcome = at(3).chooseDecision("enable-cache", { rationale: "Reads dominate" });
    if (outcome.status !== "applied") throw new Error(outcome.reason);
    expect(outcome.record.costImpact.monthly).toBe(255.5);
    expect(outcome.record.complexityImpact).toBe(3);
    expect(outcome.record.stateAfter.flags.staleReads).toBe(true);
  });

  it("is hit by an eviction storm at T+18 and has to warm up again", () => {
    const simulation = at(3, ["enable-cache"]);
    simulation.advance(14);
    expect(simulation.getState().metrics.cacheHitRate).toBe(0.9);
    const report = simulation.advance(1);
    expect(report.events.map((event) => event.eventId)).toEqual(["cache-eviction"]);
    expect(report.state.metrics.cacheHitRate).toBe(0.45);
  });
});

describe("read replica", () => {
  it("takes half of the reads immediately, but none of the writes", () => {
    const outcome = at(6).chooseDecision("add-database-replica", { rationale: "Spread reads" });
    if (outcome.status !== "applied") throw new Error(outcome.reason);
    const { stateAfter } = outcome.record;
    const toPrimary = stateAfter.dependencies.filter((dependency) => dependency.to === "db");
    expect(toPrimary).toEqual([
      { from: "app", to: "db", traffic: "read", share: 0.5 },
      { from: "app", to: "db", traffic: "write", share: 1 },
    ]);
    expect(component(stateAfter, "replica").utilization).toBeGreaterThan(0);
    expect(outcome.record.costImpact.monthly).toBe(876);
    expect(outcome.record.complexityImpact).toBe(2);
  });

  it("can be removed again, giving reads back to the primary", () => {
    const simulation = at(6, ["add-database-replica", "remove-database-replica"]);
    expect(simulation.getState().components.map((c) => c.id)).not.toContain("replica");
    expect(simulation.getState().dependencies.filter((dependency) => dependency.to === "db")).toEqual([
      { from: "app", to: "db", traffic: "read", share: 1 },
      { from: "app", to: "db", traffic: "write", share: 1 },
    ]);
    expect(simulation.getState().complexityScore).toBe(3);
  });
});

describe("rate limiting", () => {
  it("rejects traffic above the limit and protects the backend", () => {
    const unprotected = at(6).getState().metrics;
    const protectedState = at(6, ["enable-rate-limiting", "enable-cache", "scale-application"]);
    protectedState.advance(5);
    const { metrics } = protectedState.getState();
    expect(metrics.requestsPerSecond).toBe(80000);
    expect(metrics.throttleRate).toBe(0.5);
    expect(metrics.serverErrorRate).toBeLessThan(0.01);
    expect(unprotected.serverErrorRate).toBeGreaterThan(0.5);
  });

  it("is adjusted in 10,000 rps steps, never below 10,000", () => {
    const simulation = at(3, ["enable-rate-limiting"]);
    const limit = () => component(simulation.getState(), "gateway").configuration.rateLimit;
    expect(limit()).toBe(40000);
    for (let i = 0; i < 4; i++) simulation.chooseDecision("tighten-rate-limit", { rationale: "Tighter" });
    expect(limit()).toBe(10000);
    simulation.chooseDecision("relax-rate-limit", { rationale: "Looser" });
    expect(limit()).toBe(20000);
  });

  it("counts throttled requests separately from failures, with a lower business cost", () => {
    const result = play(strategy("D")).getResult();
    expect(result.impact.throttledRequests).toBeGreaterThan(0);
    expect(result.impact.businessImpact).toBeCloseTo(result.impact.failedRequests * 0.002 + result.impact.throttledRequests * 0.001, 1);
  });
});

describe("investigation", () => {
  it("takes logical time while the incident continues, and changes nothing about the system", () => {
    const investigated = at(3, ["investigate-database"]);
    const waited = at(5);
    expect(investigated.getTime()).toBe(5);
    expect(investigated.getState().components).toEqual(waited.getState().components);
    expect(investigated.getState().metrics).toEqual(waited.getState().metrics);
  });

  it("reveals PostgreSQL's condition and the cost of writes", () => {
    const outcome = at(3).chooseDecision("investigate-database", { rationale: "Is the database the problem?" });
    if (outcome.status !== "applied") throw new Error(outcome.reason);
    expect(outcome.record.knowledge.map((value) => value.id)).not.toContain("database-cpu");
    expect(outcome.record.revealed.map((value) => value.id)).toEqual(["database-cpu", "database-latency", "write-cost"]);
    expect(outcome.record.revealed.find((value) => value.id === "write-cost")?.value).toBe(1.25);
  });
});

describe("budget reduction", () => {
  it("lowers the budget to $2,800 at T+25 and records when it changed", () => {
    const simulation = createSimulation(scenario);
    simulation.runToCompletion();
    const changes = simulation.getPostmortem().constraints.timeline.filter((entry) => entry.constraint.id === "budget");
    expect(changes.map((entry) => [entry.time, entry.change, "limit" in entry.constraint ? entry.constraint.limit : null])).toEqual([
      [0, "added", 3500],
      [25, "updated", 2800],
    ]);
  });

  it("turns capacity that was within budget at the peak into a violation", () => {
    const simulation = at(3, ["enable-cache", "scale-application", "scale-application", "scale-application"]);
    expect(simulation.getState().metrics.monthlyCost).toBeLessThan(3500);
    expect(simulation.getState().metrics.monthlyCost).toBeGreaterThan(2800);
    simulation.runToCompletion();
    const result = simulation.getResult();
    expect(result.constraintsViolated.filter((violation) => violation.constraintId === "budget")).toMatchObject([{ startedAt: 25, endedAt: null }]);
    expect(result.outcome).not.toBe("success");
  });

  it("is why every playbook that succeeds cleans up after the peak", () => {
    // Strategy C without its clean-up: everything it bought for the peak is still running.
    const steps = strategy("C").steps.filter((step) => step.at < 30);
    const result = replay(scenario, toActions(steps, scenario)).getResult();
    expect(result.metrics.totalCost).toBeGreaterThan(2800);
    expect(result.outcome).not.toBe("success");
    expect(play(strategy("C")).getResult().outcome).toBe("success");
  });
});

describe("asynchronous writes", () => {
  it("builds a backlog at the peak and drains it once traffic falls", () => {
    const simulation = at(3, ["enable-cache", "enable-async-writes", "scale-application", "scale-application", "scale-application", "scale-application"]);
    simulation.runToCompletion();
    const depth = (minute: number) => simulation.getHistory().samples.find((sample) => sample.time === minute)?.metrics.queueDepth ?? 0;
    expect(depth(8)).toBe(0);
    expect(depth(20)).toBeGreaterThan(depth(15));
    expect(depth(45)).toBeLessThan(depth(30));
    expect(simulation.getState().flags.eventualConsistency).toBe(true);
  });

  it("does not fit alongside a cache and a rate limit within what the team can operate", () => {
    const simulation = at(3, ["enable-cache", "enable-async-writes"]);
    expect(simulation.chooseDecision("enable-rate-limiting", { rationale: "More protection" })).toMatchObject({
      status: "unavailable",
      reason: expect.stringMatching(/Complexity limit would be exceeded: 11 of 10/),
    });
  });
});

describe("delayed consequences", () => {
  it("upgrades PostgreSQL only after a three-minute failover, during which it is degraded", () => {
    const simulation = at(0, ["upgrade-database"]);
    const db = () => component(simulation.getState(), "db");
    expect([db().health, db().capacity]).toEqual(["degraded", 15000]);
    simulation.advance(2);
    expect([db().health, db().capacity]).toEqual(["degraded", 15000]);
    simulation.advance(1);
    expect([db().health, db().capacity]).toEqual(["healthy", 30000]);
    expect(simulation.chooseDecision("upgrade-database", { rationale: "Again" }).status).toBe("invalid");
  });

  it("makes an upgrade in the middle of the surge hurt before it helps", () => {
    const upgraded = at(5, ["upgrade-database"]).getState().metrics;
    const left = at(5).getState().metrics;
    expect(upgraded.errorRate).toBeGreaterThan(left.errorRate ?? 0);
  });
});

describe("whole-incident scoring", () => {
  it("accounts for every request as successful, failed or throttled", () => {
    for (const playbook of STRATEGIES) {
      const { impact } = play(playbook).getResult();
      expect(impact.successfulRequests + impact.failedRequests + impact.throttledRequests).toBeCloseTo(impact.totalRequests, -2);
    }
  });

  it("reports SLO-violation minutes, time to stabilize, cost, complexity and business impact", () => {
    const postmortem = play(strategy("C")).getPostmortem();
    expect(postmortem.summary).toMatchObject({ outcome: "success", incidentStartedAt: 3, duration: 45 });
    expect(postmortem.summary.timeToStabilize).toBe((postmortem.summary.stabilizedAt ?? 0) - 3);
    expect(postmortem.impact.sloViolationMinutes).toBeGreaterThan(0);
    expect(postmortem.impact.violationMinutes.budget).toBeGreaterThan(0);
    expect(postmortem.cost.finalMonthlyCost).toBeLessThanOrEqual(2800);
    expect(postmortem.cost.incidentSpend).toBeGreaterThan(0);
    expect(postmortem.architecture.final.complexityScore).toBe(6);
    expect(postmortem.impact.businessImpact).toBeGreaterThan(0);
  });

  it("fails an incident nobody responds to", () => {
    const simulation = createSimulation(scenario);
    simulation.runToCompletion();
    const result = simulation.getResult();
    expect(result.outcome).toBe("failure");
    expect(result.impact.failedRequests / result.impact.totalRequests).toBeGreaterThan(0.8);
  });
});

describe("postmortem", () => {
  const postmortem = play(strategy("B")).getPostmortem();

  it("keeps each decision's rationale, what was known, the state before and after, and its cost", () => {
    const cache = postmortem.decisions.find((record) => record.decisionId === "enable-cache");
    expect(cache).toMatchObject({ timestamp: 7, rationale: expect.stringContaining("94% of requests are reads"), costImpact: { monthly: 255.5 } });
    expect(cache?.knowledge.map((value) => value.id)).toEqual(expect.arrayContaining(["read-ratio", "cacheable-reads", "database-cpu"]));
    expect(cache?.stateBefore.components.map((c) => c.id)).not.toContain("cache");
    expect(cache?.stateAfter.components.map((c) => c.id)).toContain("cache");
  });

  it("describes the final architecture and how it changed", () => {
    expect(postmortem.architecture.initial.components.map((c) => c.id)).toEqual(["client", "gateway", "app", "db"]);
    expect(postmortem.architecture.final.components.map((c) => c.id)).toEqual(["client", "gateway", "app", "db", "cache"]);
    expect(postmortem.architecture.final.monthlyCost).toBe(postmortem.cost.finalMonthlyCost);
  });

  it("lists measurable learning signals rather than explanations", () => {
    const signals = new Map(postmortem.learningSignals.map((signal) => [signal.id, signal]));
    expect(signals.get("investigated-before-acting")?.value).toBe(true);
    expect(signals.get("decisions-with-hidden-information")?.value).toBe(0);
    expect(signals.get("within-budget-at-end")).toMatchObject({ assessment: "strength", value: true });
    expect(signals.get("rationale-coverage")).toMatchObject({ assessment: "strength", value: 1 });
    expect(play(strategy("C")).getPostmortem().learningSignals.find((signal) => signal.id === "investigated-before-acting")?.value).toBe(false);
  });
});

describe("multiple viable strategies", () => {
  const summaries = STRATEGIES.map((playbook) => summarize(playbook, play(playbook)));
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));

  it("lets several different playbooks succeed, and scaling alone does not", () => {
    expect(summaries.map((summary) => [summary.id, summary.outcome])).toEqual([
      ["A", "partial"],
      ["B", "success"],
      ["C", "success"],
      ["D", "success"],
      ["E", "success"],
    ]);
  });

  it("has no playbook that is best at everything", () => {
    const keys = ["failedRequests", "throttledRequests", "sloViolationMinutes", "finalMonthlyCost", "spend", "complexity"] as const;
    for (const summary of summaries) {
      const beatenSomewhere = summaries.some((other) => other !== summary && keys.some((key) => other[key] < summary[key]));
      expect(beatenSomewhere, summary.name).toBe(true);
    }
    // Shedding load fails fewest requests; serving everything throttles none.
    expect(Math.min(...summaries.map((summary) => summary.failedRequests))).toBe(byId.get("D")?.failedRequests);
    expect(byId.get("C")?.throttledRequests).toBe(0);
  });

  it("finds successes, defensible partial outcomes and a frontier with no dominant plan in a sample of the search space", () => {
    const sample = allPlans().filter((_, index) => index % 37 === 0);
    const { results, counts, front, dominant } = explore(sample);
    expect(counts.success).toBeGreaterThan(1);
    expect(counts.partial).toBeGreaterThan(counts.success);
    expect(front.length).toBeGreaterThan(5);
    expect(dominant).toEqual([]);
    const best = (key: (typeof PARETO_KEYS)[number]) => [...results].sort((a, b) => a[key] - b[key])[0]?.name;
    expect(new Set(PARETO_KEYS.map(best)).size).toBeGreaterThan(2);
  }, 60_000);
});

describe("replay and counterfactuals", () => {
  it("ships its playbooks with the engine", () => {
    expect(trafficIncidentPlaybooks.map((playbook) => playbook.id)).toEqual(["A", "B", "C", "D", "E"]);
    expect(replay(scenario, playbookActions(trafficIncidentPlaybooks[2]!.steps, scenario)).getHistory().decisions).toHaveLength(12);
  });

  it("replays a playbook to exactly the same history and result", () => {
    const original = play(strategy("E"));
    const replayed = replay(scenario, original.getHistory().actions);
    expect(replayed.getHistory()).toEqual(original.getHistory());
    expect(JSON.stringify(replayed.getPostmortem())).toBe(JSON.stringify(original.getPostmortem()));
  });

  it("compares a decision with its alternative: a cache instead of a replica", () => {
    // Strategy A's late fix was a cache. What if it had added a replica instead?
    const actions = play(strategy("A")).getHistory().actions;
    const swapped: SimulationAction[] = actions.map((action) =>
      action.type === "decide" && action.decisionId === "enable-cache" ? { ...action, decisionId: "add-database-replica" } : action,
    );
    const withCache = replay(scenario, actions);
    const withReplica = replay(scenario, swapped);
    expect(withReplica.getResult().impact.failedRequests).toBeGreaterThan(withCache.getResult().impact.failedRequests);
    expect(withReplica.getResult().outcome).toBe("failure");
  });
});
