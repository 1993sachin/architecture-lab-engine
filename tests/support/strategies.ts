import {
  createScenario,
  replay,
  trafficIncidentScenario,
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
export function play(strategy: Strategy, scenario: Scenario = createScenario(trafficIncidentScenario)): Simulation {
  const simulation = replay(scenario, toActions(strategy.steps, scenario));
  if (!simulation.isComplete()) simulation.runToCompletion();
  return simulation;
}

export interface StrategySummary {
  id: string;
  name: string;
  outcome: SimulationResult["outcome"];
  score: number;
  peakP99: number;
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
  sloViolationMinutes: number;
  businessImpact: number;
  timeToStabilize: number | null;
}

export function summarize(strategy: Strategy, simulation: Simulation): StrategySummary {
  const result = simulation.getResult();
  const history = simulation.getHistory();
  return {
    id: strategy.id,
    name: strategy.name,
    outcome: result.outcome,
    score: result.score,
    peakP99: result.metrics.peakP99Latency,
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
    sloViolationMinutes: result.impact.sloViolationMinutes,
    businessImpact: result.impact.businessImpact ?? 0,
    timeToStabilize: simulation.getPostmortem().summary.timeToStabilize,
  };
}

/**
 * The five strategies from the Phase 2 brief, written as playbooks an engineer
 * might follow against "The 10× Traffic Incident". Each reacts to what it can
 * see at the time; none is tuned to the hidden numbers.
 */
export const STRATEGIES: Strategy[] = [
  {
    id: "A",
    name: "Scale first",
    summary: "Treat it as a capacity problem: scale the application and PostgreSQL, and only look deeper when scaling stops working.",
    steps: [
      { at: 3, decision: "scale-application", rationale: "Traffic is up 50% and latency is climbing; add capacity." },
      { at: 4, decision: "scale-application", rationale: "Errors are rising; get ahead of the ramp." },
      { at: 5, decision: "upgrade-database", rationale: "More application capacity will push more load to the database; give it room." },
      { at: 6, decision: "scale-application", rationale: "Traffic is at 50,000 rps." },
      { at: 8, decision: "investigate-database", rationale: "Scaling has not helped; errors are still above 50%." },
      { at: 10, decision: "enable-cache", rationale: "PostgreSQL is far past capacity even on the larger instance; take reads off it." },
      { at: 10, decision: "scale-application", rationale: "Second wave: keep capacity ahead of traffic." },
      { at: 11, decision: "scale-application", rationale: "Traffic heading for 100,000 rps." },
      { at: 30, decision: "downgrade-database", rationale: "Traffic has settled and Redis carries the reads; the budget is now $2,800." },
      { at: 30, decision: "scale-down-application", rationale: "Trim to the new normal." },
      { at: 31, decision: "scale-down-application", rationale: "Trim to the new normal." },
      { at: 32, decision: "scale-down-application", rationale: "Trim to the new normal." },
    ],
  },
  {
    id: "B",
    name: "Investigate first",
    summary: "Spend four minutes learning what the traffic is and where PostgreSQL stands, then act on the evidence.",
    steps: [
      { at: 3, decision: "investigate-traffic", rationale: "Do not guess: find out what the new traffic is." },
      { at: 5, decision: "investigate-database", rationale: "Errors started with the surge; check whether PostgreSQL is the bottleneck." },
      { at: 7, decision: "enable-cache", rationale: "94% of requests are reads and 90% of reads are cacheable; PostgreSQL is far past its limit." },
      { at: 7, decision: "upgrade-database", rationale: "Even a warm cache leaves PostgreSQL near its limit at 100,000 rps; writes cost 25% more than reads." },
      { at: 7, decision: "scale-application", rationale: "Application CPU is at capacity at 50,000 rps." },
      { at: 7, decision: "scale-application", rationale: "Capacity for the second wave." },
      { at: 9, decision: "scale-application", rationale: "Second wave: keep capacity ahead of traffic." },
      { at: 10, decision: "scale-application", rationale: "Traffic heading for 100,000 rps." },
      { at: 30, decision: "downgrade-database", rationale: "Redis carries the reads at the new normal; the budget is now $2,800." },
      { at: 31, decision: "scale-down-application", rationale: "Trim to the new normal." },
      { at: 32, decision: "scale-down-application", rationale: "Trim to the new normal." },
      { at: 33, decision: "scale-down-application", rationale: "Trim to the new normal." },
    ],
  },
  {
    id: "C",
    name: "Cache first",
    summary: "Bet on the read-heavy hypothesis: put Redis in front of PostgreSQL immediately, scale with the traffic, add headroom when errors persist.",
    steps: [
      { at: 3, decision: "enable-cache", rationale: "A product launch is mostly people browsing; caching attacks the cause." },
      { at: 3, decision: "scale-application", rationale: "Capacity for the climb." },
      { at: 5, decision: "scale-application", rationale: "Traffic is still climbing." },
      { at: 6, decision: "scale-application", rationale: "Traffic is at 50,000 rps." },
      { at: 9, decision: "scale-application", rationale: "Second wave: keep capacity ahead of traffic." },
      { at: 10, decision: "scale-application", rationale: "Traffic heading for 100,000 rps." },
      { at: 13, decision: "add-database-replica", rationale: "Errors persist at 100,000 rps with a 90% hit rate; the database must still be the limit." },
      { at: 30, decision: "remove-database-replica", rationale: "Traffic has settled; the budget is now $2,800." },
      { at: 30, decision: "scale-down-application", rationale: "Trim to the new normal." },
      { at: 31, decision: "scale-down-application", rationale: "Trim to the new normal." },
      { at: 32, decision: "scale-down-application", rationale: "Trim to the new normal." },
      { at: 33, decision: "scale-down-application", rationale: "Trim to the new normal." },
    ],
  },
  {
    id: "D",
    name: "Protect the system",
    summary: "Cap traffic at the gateway first, fix the backend behind the limit, then let users back in step by step.",
    steps: [
      { at: 3, decision: "enable-rate-limiting", rationale: "Protect the backend before it collapses; 429s are better than timeouts." },
      { at: 3, decision: "enable-cache", rationale: "Take reads off PostgreSQL behind the limit." },
      { at: 3, decision: "investigate-database", rationale: "Find out how much headroom PostgreSQL has before letting more traffic in." },
      { at: 5, decision: "add-database-replica", rationale: "PostgreSQL is past capacity; add read capacity that works immediately." },
      { at: 5, decision: "scale-application", rationale: "Capacity for the current limit." },
      { at: 8, decision: "relax-rate-limit", rationale: "Redis is warm and errors are low; let more users in." },
      { at: 8, decision: "scale-application", rationale: "Capacity before the next step up." },
      { at: 9, decision: "relax-rate-limit", rationale: "Still healthy; relax again." },
      { at: 9, decision: "scale-application", rationale: "Capacity before the next step up." },
      { at: 10, decision: "relax-rate-limit", rationale: "Still healthy; relax again." },
      { at: 10, decision: "scale-application", rationale: "Capacity before the next step up." },
      { at: 11, decision: "relax-rate-limit", rationale: "Still healthy; relax again." },
      { at: 12, decision: "relax-rate-limit", rationale: "Still healthy; relax again." },
      { at: 13, decision: "relax-rate-limit", rationale: "Still healthy; relax again." },
      { at: 14, decision: "relax-rate-limit", rationale: "Keep the limit above traffic as a safety net." },
      { at: 30, decision: "remove-database-replica", rationale: "Traffic has settled; the budget is now $2,800." },
      { at: 30, decision: "scale-down-application", rationale: "Trim to the new normal." },
      { at: 31, decision: "scale-down-application", rationale: "Trim to the new normal." },
      { at: 32, decision: "scale-down-application", rationale: "Trim to the new normal." },
    ],
  },
  {
    id: "E",
    name: "Balanced",
    summary: "Start the cache and scale at once, check the traffic while Redis warms, buy database headroom, and use the rate limit only as a circuit breaker.",
    steps: [
      { at: 3, decision: "enable-cache", rationale: "Reads are the likely load; start warming Redis now." },
      { at: 3, decision: "scale-application", rationale: "Capacity for the climb." },
      { at: 3, decision: "investigate-traffic", rationale: "Confirm the read-heavy hypothesis while Redis warms." },
      { at: 5, decision: "scale-application", rationale: "Traffic is still climbing." },
      { at: 5, decision: "upgrade-database", rationale: "Confirmed read-heavy; buy PostgreSQL headroom for cache misses and writes." },
      { at: 6, decision: "scale-application", rationale: "Traffic is at 50,000 rps." },
      { at: 9, decision: "scale-application", rationale: "Second wave: keep capacity ahead of traffic." },
      { at: 10, decision: "scale-application", rationale: "Traffic heading for 100,000 rps." },
      { at: 18, decision: "enable-rate-limiting", rationale: "Redis lost half its keys; shed load so PostgreSQL survives the re-warm." },
      { at: 18, decision: "relax-rate-limit", rationale: "Limit at 50,000 rps." },
      { at: 18, decision: "relax-rate-limit", rationale: "Limit at 60,000 rps." },
      { at: 18, decision: "relax-rate-limit", rationale: "Limit at 70,000 rps." },
      { at: 18, decision: "relax-rate-limit", rationale: "Limit at 80,000 rps." },
      { at: 21, decision: "relax-rate-limit", rationale: "Hit rate has recovered; lift the limit." },
      { at: 21, decision: "relax-rate-limit", rationale: "Hit rate has recovered; lift the limit." },
      { at: 30, decision: "downgrade-database", rationale: "Traffic has settled; the budget is now $2,800." },
      { at: 31, decision: "scale-down-application", rationale: "Trim to the new normal." },
      { at: 32, decision: "scale-down-application", rationale: "Trim to the new normal." },
      { at: 33, decision: "scale-down-application", rationale: "Trim to the new normal." },
    ],
  },
];
