import { describe, expect, it } from "vitest";
import { createSimulation, type DecisionDefinition } from "../src/index.ts";
import { buildScenario, component } from "./helpers.ts";

const scaleApp: DecisionDefinition = {
  id: "scale-app",
  title: "Scale the application",
  description: "Add one instance",
  immediateEffects: [{ type: "updateComponent", componentId: "app", instances: { add: 1 } }],
  complexityImpact: 0,
  repeatable: true,
};

const addCache: DecisionDefinition = {
  id: "add-cache",
  title: "Add a cache",
  description: "Redis for reads",
  immediateEffects: [
    { type: "addComponent", component: { id: "cache", type: "cache", configuration: { hitRate: 0.5 } } },
    { type: "redirect", target: "db", to: "cache", traffic: "read", fraction: 1 },
    { type: "connect", dependency: { from: "cache", to: "db", traffic: "read" } },
  ],
  ongoingEffects: [
    {
      id: "warm-up",
      description: "Cache warms up",
      effects: [{ type: "configure", componentId: "cache", key: "hitRate", change: { add: 0.1, max: 0.8 } }],
    },
  ],
  complexityImpact: 3,
  requires: { engineerDays: 2 },
};

const premiumDatabase: DecisionDefinition = {
  id: "premium-db",
  title: "Premium database",
  description: "A very expensive database tier",
  immediateEffects: [{ type: "updateComponent", componentId: "db", costPerInstance: { set: (3000 - 109.5) / 730 } }],
  complexityImpact: 0,
};

function simulationWith(decisions: DecisionDefinition[], adjust: Parameters<typeof buildScenario>[0] = () => {}) {
  return createSimulation(
    buildScenario((definition) => {
      definition.decisions = decisions;
      definition.resources = { engineerDays: 3 };
      adjust?.(definition);
    }),
  );
}

describe("decision validation", () => {
  it("accepts a valid decision and previews its consequences", () => {
    const simulation = simulationWith([addCache]);
    const validation = simulation.validateDecision("add-cache");
    expect(validation.status).toBe("valid");
    if (validation.status !== "valid") return;
    expect(validation.preview.complexityDelta).toBe(3);
    expect(validation.preview.costDelta.monthly).toBe(182.5);
    expect(validation.preview.consequences.map((c) => c.subject)).toContainEqual({ kind: "metric", metric: "databaseUtilization" });
    // Previewing changes nothing.
    expect(simulation.getState().components).toHaveLength(3);
  });

  it("marks unknown, repeated and prerequisite-failing decisions invalid", () => {
    const needsCache: DecisionDefinition = {
      ...scaleApp,
      id: "tune-cache",
      title: "Tune the cache",
      repeatable: false,
      prerequisites: [{ condition: { type: "decisionTaken", decisionId: "add-cache" } }],
    };
    const simulation = simulationWith([addCache, needsCache]);

    expect(simulation.validateDecision("nope")).toMatchObject({ status: "invalid", reason: 'Unknown decision "nope".' });
    expect(simulation.validateDecision("tune-cache")).toMatchObject({
      status: "invalid",
      reasons: ['Requires decision "add-cache" has been taken.'],
    });

    simulation.chooseDecision("add-cache", { rationale: "Reads dominate" });
    expect(simulation.validateDecision("tune-cache").status).toBe("valid");
    expect(simulation.validateDecision("add-cache")).toMatchObject({ status: "invalid", reason: '"Add a cache" has already been taken.' });
  });

  it("marks decisions unavailable when the budget would be exceeded", () => {
    const simulation = simulationWith([premiumDatabase], (definition) => {
      definition.constraints = [{ id: "budget", kind: "budget", description: "Monthly budget", limit: 2000 }];
    });
    // App (109.50) + premium database (2,890.50) = 3,000, against a 2,000 budget.
    const validation = simulation.validateDecision("premium-db");
    expect(validation).toMatchObject({ status: "unavailable", reason: "Monthly budget would be exceeded by $1,000." });
  });

  it("marks decisions unavailable when resources or team capacity run out", () => {
    const simulation = simulationWith([addCache], (definition) => {
      definition.resources = { engineerDays: 1 };
      definition.constraints = [{ id: "team", kind: "complexity", description: "Team capacity", limit: 2 }];
    });
    const validation = simulation.validateDecision("add-cache");
    expect(validation.status).toBe("unavailable");
    expect(validation.status !== "valid" && validation.reasons).toEqual([
      "Requires 2 engineerDays; only 1 available.",
      "Complexity limit would be exceeded: 3 of 2 (Team capacity).",
    ]);
  });

  it("keeps cost-cutting decisions available when the budget is already exceeded", () => {
    const scaleDown: DecisionDefinition = { ...scaleApp, id: "scale-down", immediateEffects: [{ type: "updateComponent", componentId: "app", instances: { add: -1, min: 1 } }] };
    const simulation = simulationWith([scaleApp, scaleDown], (definition) => {
      definition.initialState.components[1] = { id: "app", type: "application", instances: 3 };
      definition.constraints = [{ id: "budget", kind: "budget", description: "Budget", limit: 100 }];
    });
    expect(simulation.validateDecision("scale-app").status).toBe("unavailable");
    expect(simulation.validateDecision("scale-down").status).toBe("valid");
  });

  it("blocks decisions that would break a requirement", () => {
    const globalCdn: DecisionDefinition = {
      id: "global-cdn",
      title: "Global CDN",
      description: "Serve from every region",
      immediateEffects: [{ type: "flag", flag: "dataRegion", value: "global" }],
      complexityImpact: 1,
    };
    const simulation = simulationWith([globalCdn], (definition) => {
      definition.initialState.flags = { dataRegion: "eu" };
      definition.constraints = [
        { id: "residency", kind: "requirement", description: "EU data residency", condition: { type: "flag", flag: "dataRegion", equals: "eu" } },
      ];
    });
    expect(simulation.validateDecision("global-cdn")).toMatchObject({
      status: "unavailable",
      reason: 'Would violate "EU data residency": EU data residency: requires dataRegion is eu.',
    });
  });

  it("never applies a rejected decision, and records the attempt", () => {
    const simulation = simulationWith([premiumDatabase], (definition) => {
      definition.constraints = [{ id: "budget", kind: "budget", description: "Budget", limit: 2000 }];
    });
    const before = simulation.getState();
    const outcome = simulation.chooseDecision("premium-db", { rationale: "Need headroom" });
    expect(outcome.status).toBe("unavailable");
    expect(simulation.getState()).toEqual(before);
    const history = simulation.getHistory();
    expect(history.decisions).toHaveLength(0);
    expect(history.entries).toContainEqual(
      expect.objectContaining({ type: "rejectedDecision", decisionId: "premium-db", rationale: "Need headroom" }),
    );
  });
});

describe("decision effects", () => {
  it("applies immediate effects, complexity and resource use", () => {
    const simulation = simulationWith([addCache]);
    const outcome = simulation.chooseDecision("add-cache", { rationale: "Reads dominate" });
    expect(outcome.status).toBe("applied");
    const state = simulation.getState();
    expect(state.complexityScore).toBe(3);
    expect(state.resources["engineerDays"]).toBe(1);
    expect(component(state, "db").load.inbound).toBe(60);
  });

  it("runs ongoing effects as logical time passes", () => {
    const simulation = simulationWith([addCache]);
    simulation.chooseDecision("add-cache", { rationale: "Reads dominate" });
    expect(simulation.getState().metrics.cacheHitRate).toBe(0.5);
    simulation.advance(1);
    expect(simulation.getState().metrics.cacheHitRate).toBe(0.6);
    simulation.advance(5);
    expect(simulation.getState().metrics.cacheHitRate).toBe(0.8);
  });

  it("applies side effects only when their condition holds", () => {
    const rateLimit: DecisionDefinition = {
      id: "rate-limit",
      title: "Rate limit",
      description: "Limit to 50 rps",
      immediateEffects: [{ type: "configure", componentId: "app", key: "rateLimit", value: 50 }],
      complexityImpact: 1,
      sideEffects: [
        {
          id: "throttled",
          description: "Legitimate users are throttled.",
          when: { type: "metric", metric: "errorRate", op: ">", value: 0 },
          effects: [{ type: "flag", flag: "customersThrottled", value: true }],
        },
      ],
    };
    const busy = simulationWith([rateLimit]);
    const outcome = busy.chooseDecision("rate-limit", { rationale: "Protect the database" });
    expect(outcome.status === "applied" && outcome.record.sideEffects).toEqual(["Legitimate users are throttled."]);
    expect(busy.getState().flags["customersThrottled"]).toBe(true);

    const quiet = simulationWith([rateLimit], (definition) => {
      definition.workload.requestsPerSecond = 10;
    });
    quiet.chooseDecision("rate-limit", { rationale: "Protect the database" });
    expect(quiet.getState().flags["customersThrottled"]).toBeUndefined();
  });

  it("reports a decision that cannot fit the current system as invalid", () => {
    const broken: DecisionDefinition = { ...scaleApp, id: "broken", immediateEffects: [{ type: "setHealth", componentId: "missing", health: "down" }] };
    const validation = simulationWith([broken]).validateDecision("broken");
    expect(validation).toMatchObject({ status: "invalid", reason: 'Cannot be applied to the current system: Component "missing" does not exist.' });
  });
});
