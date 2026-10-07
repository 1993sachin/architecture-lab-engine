import {
  createScenario,
  replay,
  trafficSpikeScenario,
  type Scenario,
  type Simulation,
  type SimulationAction,
  type SimulationResult,
} from "../../src/index.ts";

/** One step of a strategy: at logical time `at`, take `decision` because of `rationale`. */
export interface StrategyStep {
  at: number;
  decision: string;
  rationale: string;
}

export interface Strategy {
  id: string;
  name: string;
  summary: string;
  steps: StrategyStep[];
}

/**
 * Turns timed steps into replayable actions. Steps scheduled for a time that has
 * already passed (because an earlier decision took time) run immediately.
 */
export function toActions(steps: readonly StrategyStep[], scenario: Scenario): SimulationAction[] {
  const actions: SimulationAction[] = [];
  let time = 0;
  for (const step of steps) {
    if (step.at > time) {
      actions.push({ type: "advance", minutes: step.at - time });
      time = step.at;
    }
    actions.push({ type: "decide", decisionId: step.decision, rationale: step.rationale });
    time += scenario.decisions.find((decision) => decision.id === step.decision)?.duration ?? 0;
  }
  return actions;
}

/** Plays a strategy to the end of the scenario. */
export function play(strategy: Strategy, scenario: Scenario = createScenario(trafficSpikeScenario)): Simulation {
  const simulation = replay(scenario, toActions(strategy.steps, scenario));
  if (!simulation.isComplete()) simulation.runToCompletion();
  return simulation;
}

export interface StrategySummary {
  id: string;
  name: string;
  outcome: SimulationResult["outcome"];
  score: number;
  peakP95: number;
  peakErrorRate: number;
  availability: number;
  finalMonthlyCost: number;
  spend: number;
  complexity: number;
  decisions: number;
  rejected: number;
  stabilizedAt: number | null;
  failedRequests: number;
  throttledRequests: number;
  minutesInViolation: number;
}

export function summarize(strategy: Strategy, simulation: Simulation): StrategySummary {
  const result = simulation.getResult();
  const history = simulation.getHistory();
  const peakP95 = Math.max(...history.samples.map((sample) => sample.metrics.p95Latency ?? 0));
  return {
    id: strategy.id,
    name: strategy.name,
    outcome: result.outcome,
    score: result.score,
    peakP95,
    peakErrorRate: result.metrics.peakErrorRate,
    availability: result.metrics.availability,
    finalMonthlyCost: result.metrics.totalCost,
    spend: result.metrics.spend,
    complexity: result.metrics.finalComplexity,
    decisions: result.decisions.length,
    rejected: history.entries.filter((entry) => entry.type === "rejectedDecision").length,
    stabilizedAt: result.impact.stabilizedAt,
    failedRequests: result.impact.failedRequests,
    throttledRequests: result.impact.throttledRequests,
    minutesInViolation: result.impact.minutesInViolation,
  };
}

/** The five strategies from the Phase 1.5 brief, played against "The 10× Traffic Incident". */
export const STRATEGIES: Strategy[] = [
  {
    id: "A",
    name: "Scale first",
    summary: "Throw capacity at it: scale the application, upgrade the database, keep scaling, trim afterwards.",
    steps: [
      { at: 3, decision: "scale-application", rationale: "Traffic is climbing and application CPU is over 100%." },
      { at: 3, decision: "scale-application", rationale: "The ramp has not stopped; get ahead of it." },
      { at: 4, decision: "increase-database-capacity", rationale: "More application capacity will push more load to the database." },
      { at: 5, decision: "scale-application", rationale: "Errors are still high; add more capacity." },
      { at: 6, decision: "scale-application", rationale: "Latency is still above the SLO." },
      { at: 36, decision: "scale-down-application", rationale: "Traffic has settled; cut cost to meet the new budget." },
      { at: 36, decision: "scale-down-application", rationale: "Still over budget." },
    ],
  },
  {
    id: "B",
    name: "Investigate first",
    summary: "Learn the read/write mix and the database's condition before acting, then add targeted capacity.",
    steps: [
      { at: 3, decision: "investigate-traffic", rationale: "Do not guess: find out what the traffic actually is." },
      { at: 5, decision: "investigate-database", rationale: "Latency is rising; check whether the database is the bottleneck." },
      { at: 7, decision: "enable-cache", rationale: "80% of requests are reads and the database is saturated." },
      { at: 7, decision: "add-database-replica", rationale: "Spread the remaining reads while the cache warms up." },
      { at: 7, decision: "scale-application", rationale: "Application CPU is far above capacity." },
      { at: 7, decision: "scale-application", rationale: "Traffic has reached 3,000 rps." },
      { at: 7, decision: "scale-application", rationale: "Match capacity to 3,000 rps with some headroom." },
      { at: 36, decision: "scale-down-application", rationale: "Traffic has settled; cut cost to meet the new budget." },
      { at: 36, decision: "scale-down-application", rationale: "Still over budget." },
    ],
  },
  {
    id: "C",
    name: "Cache first",
    summary: "Check the mix, put a cache in front of the database, watch the hit rate, then scale as needed.",
    steps: [
      { at: 3, decision: "investigate-traffic", rationale: "Confirm the traffic is read-heavy before adding a cache." },
      { at: 5, decision: "enable-cache", rationale: "Most traffic is reads; caching attacks the cause, not the symptom." },
      { at: 8, decision: "scale-application", rationale: "Cache hit rate is climbing but the application is still saturated." },
      { at: 8, decision: "scale-application", rationale: "Traffic is at 3,000 rps." },
      { at: 8, decision: "scale-application", rationale: "Leave headroom." },
      { at: 10, decision: "scale-application", rationale: "Hit rate is 85% but p95 is still above the SLO; the application is the bottleneck." },
      { at: 36, decision: "scale-down-application", rationale: "Traffic has settled; cut cost to meet the new budget." },
      { at: 36, decision: "scale-down-application", rationale: "Trim further while utilization allows." },
      { at: 36, decision: "scale-down-application", rationale: "Trim further while utilization allows." },
      { at: 36, decision: "scale-down-application", rationale: "Trim further while utilization allows." },
    ],
  },
  {
    id: "D",
    name: "Protect the system",
    summary: "Shed load first, investigate, scale behind the limit, then relax the limit gradually.",
    steps: [
      { at: 3, decision: "enable-rate-limiting", rationale: "Protect the backend before anything else falls over." },
      { at: 3, decision: "investigate-database", rationale: "Find out how much headroom the database has." },
      { at: 5, decision: "scale-application", rationale: "Scale the application behind the limit." },
      { at: 5, decision: "scale-application", rationale: "Enough application capacity for the limit." },
      { at: 5, decision: "increase-database-capacity", rationale: "The database is close to its limit." },
      { at: 12, decision: "scale-application", rationale: "Add capacity before letting more traffic in." },
      { at: 12, decision: "relax-rate-limiting", rationale: "The backend is stable; let more users in." },
      { at: 18, decision: "relax-rate-limiting", rationale: "Still stable; relax again." },
      { at: 36, decision: "scale-down-application", rationale: "Traffic has settled; cut cost." },
    ],
  },
  {
    id: "E",
    name: "Balanced",
    summary: "Investigate, scale moderately, add a cache and database capacity, then a targeted rate limit.",
    steps: [
      { at: 3, decision: "investigate-traffic", rationale: "Understand the traffic before committing money." },
      { at: 5, decision: "scale-application", rationale: "Moderate scale-out to stop the bleeding." },
      { at: 5, decision: "scale-application", rationale: "Moderate scale-out to stop the bleeding." },
      { at: 5, decision: "enable-cache", rationale: "Reads dominate; offload the database." },
      { at: 5, decision: "increase-database-capacity", rationale: "Headroom for writes and cache misses." },
      { at: 5, decision: "enable-rate-limiting", rationale: "Cap traffic at what 12 instances can serve." },
      { at: 15, decision: "scale-application", rationale: "Cache is warm; add capacity before letting more users in." },
      { at: 15, decision: "relax-rate-limiting", rationale: "The backend can now take more." },
      { at: 36, decision: "scale-down-application", rationale: "Traffic has settled; cut cost." },
      { at: 36, decision: "scale-down-application", rationale: "Trim further while utilization allows." },
    ],
  },
];
