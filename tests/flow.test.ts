import { describe, expect, it } from "vitest";
import { calculateMetrics, createSimulation, deliveryAttempts, exhaustedRate, overloadErrorRate, queueingFactor, type SystemState } from "../src/index.ts";
import { buildScenario, component } from "./helpers.ts";

/** client → app (100 rps capacity, 20 ms) only. */
function singleApp(rps: number): SystemState {
  return buildScenario((definition) => {
    definition.workload = { requestsPerSecond: rps, readRatio: 1 };
    definition.initialState.components = [
      { id: "client", type: "client" },
      { id: "app", type: "application", capacity: 100, baseLatencyMs: 20 },
    ];
    definition.initialState.dependencies = [{ from: "client", to: "app" }];
  }).initialState;
}

function mutate(state: SystemState, change: (draft: SystemState) => void): SystemState {
  const draft = structuredClone(state);
  change(draft);
  return calculateMetrics(draft);
}

describe("capacity and latency", () => {
  it("computes utilization from demand and capacity", () => {
    const state = singleApp(50);
    expect(component(state, "app").utilization).toBe(0.5);
    expect(state.metrics.cpuUtilization).toBe(0.5);
  });

  it("adds queueing delay as utilization rises", () => {
    expect(queueingFactor(0)).toBe(1);
    expect(queueingFactor(0.5)).toBe(1.25);
    expect(queueingFactor(0.9)).toBeGreaterThan(queueingFactor(0.5));
    expect(queueingFactor(1.5)).toBeGreaterThan(queueingFactor(0.99));

    const state = singleApp(50);
    expect(state.metrics.latency).toBe(25);
    expect(state.metrics.p95Latency).toBe(45);
    expect(state.metrics.p99Latency).toBe(65);
    expect(singleApp(90).metrics.latency).toBeGreaterThan(singleApp(50).metrics.latency ?? 0);
  });

  it("fails more than the excess when capacity is exceeded (congestion collapse)", () => {
    expect(overloadErrorRate(1)).toBe(0);
    expect(overloadErrorRate(2)).toBeCloseTo(0.8);
    expect(overloadErrorRate(4)).toBe(1);
    const state = singleApp(200);
    expect(component(state, "app").utilization).toBe(2);
    expect(state.metrics.errorRate).toBeCloseTo(0.8);
    expect(state.metrics.availability).toBeCloseTo(0.2);
  });

  it("reports only metrics that apply to the system", () => {
    const state = singleApp(50);
    expect(state.metrics.cacheHitRate).toBeUndefined();
    expect(state.metrics.queueDepth).toBeUndefined();
    expect(state.metrics.databaseUtilization).toBeUndefined();
  });

  it("limits reported metrics to the scenario's list", () => {
    const scenario = buildScenario((definition) => {
      definition.metrics = ["latency", "errorRate"];
    });
    expect(Object.keys(scenario.initialState.metrics).sort()).toEqual(["errorRate", "latency"]);
  });
});

describe("dependencies and failure propagation", () => {
  const healthy = buildScenario().initialState;

  it("routes read and write traffic along matching edges", () => {
    const db = component(healthy, "db");
    expect(db.load.inbound).toBe(100);
    expect(healthy.metrics.databaseUtilization).toBe(0.1);
  });

  it("propagates database latency to the application and clients", () => {
    const app = component(healthy, "app");
    expect(app.load.latencyMs).toBeCloseTo(app.load.ownLatencyMs + component(healthy, "db").load.latencyMs, 4);
    expect(component(healthy, "client").load.latencyMs).toBe(app.load.latencyMs);
  });

  it("raises latency and errors upstream when the database becomes unhealthy", () => {
    const unhealthy = mutate(healthy, (draft) => {
      component(draft, "db").health = "unhealthy";
    });
    expect(component(unhealthy, "app").load.ownErrorRate).toBe(0);
    expect(component(unhealthy, "app").load.errorRate).toBeGreaterThan(0);
    expect(unhealthy.metrics.latency).toBeGreaterThan(healthy.metrics.latency ?? 0);
    expect(unhealthy.metrics.errorRate).toBeGreaterThanOrEqual(0.1);
  });

  it("fails every request that needs a database that is down", () => {
    const down = mutate(healthy, (draft) => {
      component(draft, "db").health = "down";
    });
    expect(down.metrics.errorRate).toBe(1);
    expect(down.metrics.availability).toBe(0);
  });

  it("degrades clients when the database's capacity is exceeded", () => {
    const overloaded = mutate(healthy, (draft) => {
      component(draft, "db").capacity = 50;
    });
    expect(component(overloaded, "db").utilization).toBe(2);
    expect(overloaded.metrics.errorRate).toBeGreaterThan(0.5);
    expect(overloaded.metrics.latency).toBeGreaterThan(healthy.metrics.latency ?? 0);
  });
});

describe("caches, rate limits and queues", () => {
  const withCache = (hitRate: number) =>
    buildScenario((definition) => {
      definition.initialState.components.push({ id: "cache", type: "cache", configuration: { hitRate } });
      definition.initialState.dependencies = [
        { from: "client", to: "app" },
        { from: "app", to: "cache", traffic: "read" },
        { from: "cache", to: "db", traffic: "read" },
        { from: "app", to: "db", traffic: "write" },
      ];
    }).initialState;

  it("serves cache hits without touching the database", () => {
    const state = withCache(0.75);
    // 80 reads, 75% hit → 20 reads reach the db, plus 20 writes.
    expect(component(state, "db").load.inbound).toBe(40);
    expect(state.metrics.cacheHitRate).toBe(0.75);
    expect(state.metrics.latency).toBeLessThan(buildScenario().initialState.metrics.latency ?? 0);
  });

  it("rejects traffic above the rate limit and shields dependencies", () => {
    const state = buildScenario((definition) => {
      definition.workload.requestsPerSecond = 400;
      definition.initialState.components.splice(1, 0, { id: "gw", type: "apiGateway", configuration: { rateLimit: 200 } });
      definition.initialState.dependencies[0] = { from: "client", to: "gw" };
      definition.initialState.dependencies.push({ from: "gw", to: "app" });
    }).initialState;
    const gateway = component(state, "gw");
    expect(gateway.load.throttled).toBe(200);
    expect(component(state, "app").load.inbound).toBe(200);
    expect(component(state, "app").utilization).toBe(1);
    expect(state.metrics.errorRate).toBe(0.5);
  });

  it("decouples callers from slow consumers and accumulates a backlog", () => {
    const scenario = buildScenario((definition) => {
      definition.workload = { requestsPerSecond: 100, readRatio: 0 };
      definition.initialState.components.push(
        { id: "queue", type: "queue" },
        { id: "worker", type: "worker", capacity: 50, baseLatencyMs: 500 },
      );
      definition.initialState.dependencies = [
        { from: "client", to: "app" },
        { from: "app", to: "queue" },
        { from: "queue", to: "worker" },
        { from: "worker", to: "db" },
      ];
    });
    const state = scenario.initialState;
    // The slow worker does not add to request latency.
    expect(state.metrics.latency).toBeLessThan(100);
    expect(component(state, "worker").load.inbound).toBe(50);

    const simulation = createSimulation(scenario);
    simulation.advance(2);
    // 50 rps more than the worker can take, for two minutes.
    expect(simulation.getState().metrics.queueDepth).toBe(6000);
  });

  it("drains a backlog once consumers have spare capacity", () => {
    const scenario = buildScenario((definition) => {
      definition.workload = { requestsPerSecond: 100, readRatio: 0 };
      definition.initialState.components.push({ id: "queue", type: "queue" }, { id: "worker", type: "worker", capacity: 50 });
      definition.initialState.dependencies = [
        { from: "client", to: "app" },
        { from: "app", to: "queue" },
        { from: "queue", to: "worker" },
      ];
      definition.events = [
        { id: "quiet", title: "Quiet", description: "Traffic drops", trigger: { at: 2 }, effects: [{ type: "workload", requestsPerSecond: { set: 0 } }] },
      ];
    });
    const simulation = createSimulation(scenario);
    simulation.advance(2);
    expect(simulation.getState().metrics.queueDepth).toBe(6000);
    simulation.advance(1);
    expect(simulation.getState().metrics.queueDepth).toBe(3000);
    simulation.advance(2);
    expect(simulation.getState().metrics.queueDepth).toBe(0);
  });
});

describe("bounded queues", () => {
  it("rejects new work once the queue is full", () => {
    const scenario = buildScenario((definition) => {
      definition.workload = { requestsPerSecond: 100, readRatio: 0 };
      definition.initialState.components.push(
        { id: "queue", type: "queue", configuration: { maxDepth: 4500 } },
        { id: "worker", type: "worker", capacity: 50 },
      );
      definition.initialState.dependencies = [
        { from: "client", to: "app" },
        { from: "app", to: "queue" },
        { from: "queue", to: "worker" },
      ];
    });
    const simulation = createSimulation(scenario);
    simulation.advance(1);
    // 50 rps more than the worker takes: 3,000 messages after a minute, still accepting.
    expect(simulation.getState().metrics).toMatchObject({ queueDepth: 3000, errorRate: 0 });
    simulation.advance(1);
    // Full (capped at 4,500): only what the worker drains is accepted.
    expect(simulation.getState().metrics).toMatchObject({ queueDepth: 4500, errorRate: 0.5 });
  });
});

describe("processing metrics and retries", () => {
  /** client → app → queue → worker (capacity 50) → db, all writes. */
  function pipeline(options: { rps: number; workerErrors?: number; maxAttempts?: number; dbCapacity?: number }) {
    return buildScenario((definition) => {
      definition.workload = { requestsPerSecond: options.rps, readRatio: 0 };
      definition.initialState.components = [
        { id: "client", type: "client" },
        { id: "app", type: "application", capacity: 1000 },
        { id: "queue", type: "queue", configuration: { maxAttempts: options.maxAttempts ?? 1 } },
        { id: "worker", type: "worker", capacity: 50, configuration: { baseErrorRate: options.workerErrors ?? 0 } },
        { id: "db", type: "database", capacity: options.dbCapacity ?? 1000 },
      ];
      definition.initialState.dependencies = [
        { from: "client", to: "app" },
        { from: "app", to: "queue" },
        { from: "queue", to: "worker" },
        { from: "worker", to: "db" },
      ];
    });
  }

  it("averages deliveries per message from the failure rate and the attempt limit", () => {
    expect(deliveryAttempts(0, 6)).toBe(1);
    expect(deliveryAttempts(0.5, 1)).toBe(1);
    expect(deliveryAttempts(0.5, 2)).toBe(1.5);
    expect(deliveryAttempts(1, 4)).toBe(4);
    expect(exhaustedRate(0.5, 2)).toBe(0.25);
    expect(exhaustedRate(0.1, 1)).toBe(0.1);
  });

  it("reports processing rate, worker utilization and processing delay", () => {
    const simulation = createSimulation(pipeline({ rps: 100 }));
    const initial = simulation.getState().metrics;
    expect(initial).toMatchObject({ processingRate: 50, workerUtilization: 1, processingDelay: 0, retryRate: 0, jobFailureRate: 0 });
    simulation.advance(1);
    // 3,000 messages waiting, drained at 50 a second: a new message waits a minute.
    expect(simulation.getState().metrics).toMatchObject({ queueDepth: 3000, processingDelay: 60 });
  });

  it("does not retry by default: failed messages are given up on", () => {
    const { metrics } = pipeline({ rps: 40, workerErrors: 0.2 }).initialState;
    expect(metrics.retryRate).toBe(0);
    expect(metrics.jobFailureRate).toBe(0.2);
  });

  it("puts failed deliveries back on the queue when retries are allowed", () => {
    const scenario = pipeline({ rps: 40, workerErrors: 0.5, maxAttempts: 2 });
    const { metrics } = scenario.initialState;
    // Half of the 40 deliveries fail; a third of all deliveries are retries in steady state (1.5 per message).
    expect(metrics.retryRate).toBeCloseTo(1 / 3, 3);
    expect(metrics.jobFailureRate).toBe(0.25);
    const simulation = createSimulation(scenario);
    simulation.advance(1);
    // The retries are extra work: 40 new + ~13 retried a second against 50 of capacity.
    expect(simulation.getState().metrics.queueDepth).toBeGreaterThan(0);
  });

  it("counts failures of what the consumers call: an overloaded database causes retries", () => {
    const healthy = pipeline({ rps: 40, maxAttempts: 3, dbCapacity: 1000 }).initialState.metrics;
    const overloaded = pipeline({ rps: 40, maxAttempts: 3, dbCapacity: 25 }).initialState.metrics;
    expect(healthy.retryRate).toBe(0);
    expect(overloaded.databaseUtilization).toBeGreaterThan(1);
    expect(overloaded.retryRate).toBeGreaterThan(0.2);
  });
});

describe("request cost and baseline errors", () => {
  /** client → app → db with 100 rps, 80% reads, db capacity 100. */
  function weighted(configuration: Record<string, number>): SystemState {
    return buildScenario((definition) => {
      definition.initialState.components[2] = { id: "db", type: "database", capacity: 100, configuration };
    }).initialState;
  }

  it("weighs database demand by the cost of each request class", () => {
    expect(component(weighted({}), "db").utilization).toBe(1);
    // 80 reads × 1 + 20 writes × 1.5 = 110 units of work.
    expect(component(weighted({ writeCost: 1.5 }), "db").utilization).toBe(1.1);
    expect(component(weighted({ readCost: 0.5 }), "db").utilization).toBe(0.6);
  });

  it("fails a fixed fraction of requests regardless of load", () => {
    const state = buildScenario((definition) => {
      definition.initialState.components[1] = { id: "app", type: "application", capacity: 200, configuration: { baseErrorRate: 0.001 } };
    }).initialState;
    expect(state.metrics.errorRate).toBe(0.001);
    expect(state.metrics.serverErrorRate).toBe(0.001);
  });
});

describe("throttled and server errors", () => {
  it("splits the error rate into rate-limited requests and server errors", () => {
    const state = buildScenario((definition) => {
      definition.workload.requestsPerSecond = 400;
      definition.initialState.components.push({ id: "gw", type: "apiGateway", capacity: null, configuration: { rateLimit: 300 } });
      definition.initialState.dependencies[0] = { from: "client", to: "gw" };
      definition.initialState.dependencies.push({ from: "gw", to: "app" });
    }).initialState;
    // 100 of 400 rps throttled; the app (capacity 200) is overloaded by the 300 it accepts.
    expect(state.metrics.throttleRate).toBe(0.25);
    expect(state.metrics.serverErrorRate).toBeGreaterThan(0.25);
    expect((state.metrics.throttleRate ?? 0) + (state.metrics.serverErrorRate ?? 0)).toBeCloseTo(state.metrics.errorRate ?? 0, 4);
  });
});
