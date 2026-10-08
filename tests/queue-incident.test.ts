/**
 * Scenario-level tests for "The Queue That Won't Drain": the mechanics it
 * relies on (backlog, processing rate and delay, retries, a database behind
 * the workers), the reference playbooks, the decision landscape, replay and
 * counterfactuals.
 */
import { describe, expect, it } from "vitest";
import {
  createScenario,
  createSimulation,
  playbookActions,
  queueWontDrainPlaybooks,
  queueWontDrainScenario,
  replay,
  type Playbook,
  type Simulation,
  type SimulationAction,
} from "../src/index.ts";
import { component } from "./helpers.ts";
import { exploreQueue, QUEUE_PARETO_KEYS } from "./support/queue-landscape.ts";

const scenario = createScenario(queueWontDrainScenario);

function at(minute: number, decisions: string[] = []): Simulation {
  const simulation = createSimulation(scenario);
  if (minute > 0) simulation.advance(minute);
  for (const decisionId of decisions) {
    const outcome = simulation.chooseDecision(decisionId, { rationale: "test" });
    if (outcome.status !== "applied") throw new Error(`${decisionId}: ${outcome.reason}`);
  }
  return simulation;
}

function run(steps: Playbook["steps"]): Simulation {
  const simulation = replay(scenario, playbookActions(steps, scenario));
  if (!simulation.isComplete()) simulation.runToCompletion();
  return simulation;
}

function playbook(id: string): Playbook {
  const found = queueWontDrainPlaybooks.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No playbook ${id}`);
  return found;
}

const sampleAt = (simulation: Simulation, minute: number) => simulation.getHistory().samples.find((sample) => sample.time === minute)?.metrics;

describe("baseline", () => {
  it("starts healthy: 5,000 jobs/s, workers at ~72%, PostgreSQL at ~65%, no backlog to speak of", () => {
    const { metrics } = scenario.initialState;
    expect(metrics.requestsPerSecond).toBe(5000);
    expect(metrics.workerUtilization).toBeCloseTo(0.72, 2);
    expect(metrics.databaseUtilization).toBeCloseTo(0.65, 2);
    expect(metrics.processingDelay).toBe(0);
    expect(metrics.availability).toBe(1);
    expect(metrics.p99Latency).toBeLessThan(60);
  });

  it("stays stable until the workload rises", () => {
    const simulation = at(3);
    expect(simulation.getState().metrics.processingDelay).toBeLessThan(5);
    expect(simulation.getState().constraints.filter((constraint) => constraint.kind === "metric")).toHaveLength(2);
    expect(simulation.getHistory().samples.every((sample) => sample.violations.length === 0)).toBe(true);
  });

  it("hides worker load, database load and retries until someone investigates", () => {
    const visible = createSimulation(scenario).getObservations().map((value) => value.id);
    expect(visible).toEqual(expect.arrayContaining(["incoming-jobs", "queue-depth", "processing-rate", "processing-delay", "api-latency"]));
    for (const hidden of ["worker-utilization", "worker-capacity", "database-utilization", "retry-rate", "job-failure-rate", "max-attempts"]) expect(visible).not.toContain(hidden);
  });
});

describe("queue growth", () => {
  it("grows once incoming jobs exceed what the workers process, while the API stays healthy", () => {
    const simulation = createSimulation(scenario);
    simulation.runToCompletion();
    const early = sampleAt(simulation, 8);
    const later = sampleAt(simulation, 14);
    expect(early?.queueDepth).toBeLessThan(10000);
    expect(later?.requestsPerSecond).toBeGreaterThan(later?.processingRate ?? 0);
    expect(later?.queueDepth).toBeGreaterThan(200000);
    expect(later?.workerUtilization).toBe(1);
    expect(later?.availability).toBe(1);
    expect(later?.p99Latency).toBeLessThan(60);
  });

  it("breaches the freshness SLO, not an API SLO, first", () => {
    const simulation = createSimulation(scenario);
    simulation.runToCompletion();
    const first = simulation.getHistory().samples.find((sample) => sample.violations.length > 0);
    expect(first?.violations).toEqual(["freshness-slo"]);
    expect(first?.time).toBeGreaterThanOrEqual(12);
    expect(first?.time).toBeLessThanOrEqual(17);
  });

  it("reports processing delay as the backlog ahead of a new job at the current processing rate", () => {
    const { metrics } = at(16).getState();
    expect(metrics.processingDelay).toBeCloseTo((metrics.queueDepth ?? 0) / (metrics.processingRate ?? 1), 0);
  });

  it("fails if nothing is done", () => {
    const simulation = createSimulation(scenario);
    simulation.runToCompletion();
    expect(simulation.getResult().outcome).toBe("failure");
  });
});

describe("worker scaling", () => {
  it("raises processing capacity", () => {
    const before = at(15).getState();
    const after = at(15, ["scale-workers"]).getState();
    expect(component(after, "workers").instances).toBe(18);
    expect(after.metrics.processingRate).toBeGreaterThan((before.metrics.processingRate ?? 0) * 1.4);
  });

  it("pushes PostgreSQL past its capacity, and failed writes come back as retries", () => {
    const simulation = at(17, ["scale-workers"]);
    simulation.advance(1);
    const { metrics } = simulation.getState();
    expect(metrics.databaseUtilization).toBeGreaterThan(1.3);
    expect(metrics.retryRate).toBeGreaterThan(0.3);
  });
});

describe("database bottleneck", () => {
  it("tightens at T+16 when month-end reporting takes part of PostgreSQL", () => {
    const before = at(15).getState().metrics.databaseUtilization ?? 0;
    const after = at(17).getState().metrics.databaseUtilization ?? 0;
    expect(before).toBeLessThan(1);
    expect(after).toBeGreaterThan(1);
  });

  it("is relieved by the larger instance once the failover completes", () => {
    const simulation = at(17, ["upgrade-database"]);
    simulation.advance(4);
    expect(simulation.getState().metrics.databaseUtilization).toBeLessThan(0.6);
    expect(simulation.getState().metrics.retryRate).toBeLessThan(0.02);
  });
});

describe("retry amplification", () => {
  it("turns failures into extra deliveries: more attempts per job than jobs", () => {
    const simulation = at(17, ["scale-workers"]);
    simulation.advance(1);
    const { metrics } = simulation.getState();
    const jobsPerSecond = (metrics.processingRate ?? 0) * (1 - (metrics.retryRate ?? 0));
    expect(metrics.processingRate).toBeGreaterThan(jobsPerSecond * 1.4);
  });

  it("is cut by limiting retries, at the price of giving up on more jobs", () => {
    const storm = at(17, ["scale-workers"]);
    storm.advance(1);
    const limited = at(17, ["scale-workers", "limit-retries"]);
    expect(limited.getState().metrics.retryRate).toBeLessThan(storm.getState().metrics.retryRate ?? 0);
    expect(limited.getState().metrics.jobFailureRate).toBeGreaterThan(storm.getState().metrics.jobFailureRate ?? 0);
  });

  it("means adding workers in front of a struggling database makes freshness worse, not better", () => {
    const result = run(playbook("E").steps).getResult();
    expect(result.outcome).toBe("failure");
  });
});

describe("controlling incoming work", () => {
  it("rate limiting stops the backlog growing, at the API's expense", () => {
    const limited = at(15, ["enable-rate-limiting"]);
    limited.advance(3);
    const free = at(18);
    expect(limited.getState().metrics.queueDepth).toBeLessThan(free.getState().metrics.queueDepth ?? 0);
    expect(limited.getState().metrics.availability).toBeLessThan(0.99);
    expect(limited.getState().metrics.throttleRate).toBeGreaterThan(0);
  });

  it("pausing low-priority work lets the workers drain the backlog, but it has a deadline", () => {
    const paused = at(15, ["pause-low-priority"]);
    paused.advance(10);
    expect(paused.getState().metrics.queueDepth).toBeLessThan(at(15).getState().metrics.queueDepth ?? 0);
    paused.advance(38 - paused.getTime());
    expect(paused.getHistory().samples.at(-1)?.violations).toContain("low-priority-deadline");
  });
});

describe("multiple successful strategies", () => {
  it("has at least three distinct playbooks that succeed", () => {
    const successes = queueWontDrainPlaybooks.filter((candidate) => run(candidate.steps).getResult().outcome === "success");
    expect(successes.map((candidate) => candidate.id)).toEqual(["A", "B", "C", "D"]);
  });

  it("makes each successful playbook pay differently: no playbook is best on everything", () => {
    const summaries = ["A", "B", "C", "D"].map((id) => {
      const result = run(playbook(id).steps).getResult();
      return { id, cost: result.metrics.totalCost, slo: result.impact.sloViolationMinutes, impact: result.impact.businessImpact ?? 0, complexity: result.metrics.finalComplexity, spend: result.metrics.spend };
    });
    for (const summary of summaries) {
      const keys = ["cost", "slo", "impact", "complexity", "spend"] as const;
      const bestOnAll = summaries.every((other) => keys.every((key) => summary[key] <= other[key]));
      expect(bestOnAll, `${summary.id} is best on every measure`).toBe(false);
    }
  });
});

describe("decision landscape", () => {
  const { successes, front, dominant, counts } = exploreQueue();

  it("has successful, partial and failed plans", () => {
    expect(counts.success).toBeGreaterThan(20);
    expect(counts.partial).toBeGreaterThan(20);
    expect(counts.failure).toBeGreaterThan(20);
  });

  it("has no plan that dominates every other successful plan", () => {
    expect(dominant).toHaveLength(0);
    expect(front.length).toBeGreaterThan(5);
  });

  it("does not require any single mitigation to succeed", () => {
    for (const mitigation of ["scale-workers", "upgrade-database", "increase-batch-size", "limit-retries", "pause-low-priority", "enable-rate-limiting"]) {
      expect(successes.some((plan) => !plan.spec.mitigations.includes(mitigation)), mitigation).toBe(true);
    }
  });

  it("trades cost against freshness: the cheapest success is not the freshest", () => {
    const cheapest = [...successes].sort((a, b) => a.finalMonthlyCost - b.finalMonthlyCost || a.averageDelay - b.averageDelay)[0];
    const freshest = [...successes].sort((a, b) => a.averageDelay - b.averageDelay)[0];
    expect(cheapest?.averageDelay).toBeGreaterThan(freshest?.averageDelay ?? 0);
    expect(cheapest?.finalMonthlyCost).toBeLessThan(freshest?.finalMonthlyCost ?? 0);
    expect(QUEUE_PARETO_KEYS).toContain("failedJobs");
  });
});

describe("failure and recovery", () => {
  it("a poor first move can be recovered from by fixing what it exposed", () => {
    const poor = run([{ at: 15, decision: "scale-workers", rationale: "More workers" }]);
    const recovered = run([
      { at: 15, decision: "scale-workers", rationale: "More workers" },
      { at: 18, decision: "investigate-database", rationale: "Did that help?" },
      { at: 20, decision: "upgrade-database", rationale: "PostgreSQL is failing writes" },
      { at: 42, decision: "scale-down-workers", rationale: "Backlog gone" },
    ]);
    expect(poor.getResult().outcome).not.toBe("success");
    expect(recovered.getResult().outcome).toBe("success");
  });
});

describe("determinism and counterfactuals", () => {
  it("replays identically", () => {
    const actions: SimulationAction[] = playbookActions(playbook("B").steps, scenario);
    const a = replay(scenario, actions);
    const b = replay(scenario, actions);
    a.runToCompletion();
    b.runToCompletion();
    expect(JSON.stringify(b.getResult())).toBe(JSON.stringify(a.getResult()));
  });

  it("changing one decision makes a measurable difference", () => {
    const steps = playbook("A").steps;
    const original = run(steps).getResult();
    const swapped = run(steps.map((step) => (step.decision === "upgrade-database" ? { ...step, decision: "limit-retries" } : step))).getResult();
    expect(swapped.impact.sloViolationMinutes).not.toBe(original.impact.sloViolationMinutes);
    expect(swapped.metrics.totalCost).not.toBe(original.metrics.totalCost);
  });
});
