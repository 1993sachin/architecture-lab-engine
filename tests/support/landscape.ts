/**
 * Explores the decision space of "The 10× Traffic Incident" by brute force and
 * reports outcomes and the Pareto frontier.
 *
 * A plan is a combination of: how much to investigate before acting, which
 * mitigations to apply when acting, how the rate limit (if any) is set and
 * relaxed, how many application scale-outs happen early and as traffic keeps
 * climbing, and whether capacity is cleaned up once traffic settles.
 *
 *   npm run report:landscape
 */
import { createScenario, replay, trafficIncidentScenario, type Scenario, type SimulationAction } from "../../src/index.ts";

export const MITIGATIONS = ["enable-cache", "add-database-replica", "upgrade-database", "enable-async-writes", "enable-rate-limiting"] as const;
export const INVESTIGATIONS = [[], ["investigate-traffic"], ["investigate-database"], ["investigate-traffic", "investigate-database"]] as const;
/** Rate limit handling: starting limit (thousands of rps) and when to relax it. */
export const RATE_LIMITS = [
  { start: 40, relax: "never" },
  { start: 40, relax: "gradually" },
  { start: 40, relax: "after-peak" },
  { start: 20, relax: "never" },
  { start: 20, relax: "gradually" },
  { start: 20, relax: "after-peak" },
] as const;

export interface PlanSpec {
  investigations: readonly string[];
  mitigations: readonly string[];
  rateLimit: (typeof RATE_LIMITS)[number] | null;
  earlyScaleOuts: number;
  lateScaleOuts: number;
  cleanup: boolean;
}

export interface PlanResult {
  name: string;
  spec: PlanSpec;
  /** The decisions that were actually applied, with their times. Plans whose extra steps were refused collapse into one. */
  applied: string;
  outcome: "success" | "partial" | "failure";
  score: number;
  failedRequests: number;
  throttledRequests: number;
  sloViolationMinutes: number;
  peakP99: number;
  finalMonthlyCost: number;
  incidentSpend: number;
  complexity: number;
  /** Minutes from the start of the incident (T+3) to stabilization; the run length when never. */
  timeToStabilize: number;
  businessImpact: number;
  availability: number;
}

/** Objectives a plan can be better or worse at. Lower is better for every key. */
export const PARETO_KEYS = [
  "failedRequests",
  "throttledRequests",
  "sloViolationMinutes",
  "peakP99",
  "finalMonthlyCost",
  "incidentSpend",
  "complexity",
  "timeToStabilize",
  "businessImpact",
] as const;

const decide = (decisionId: string, rationale = "landscape exploration"): SimulationAction => ({ type: "decide", decisionId, rationale });

/** Turns a plan into replayable actions. */
export function planActions(spec: PlanSpec, scenario: Scenario): SimulationAction[] {
  const actions: SimulationAction[] = [];
  let time = 0;
  const at = (minute: number) => {
    if (minute > time) {
      actions.push({ type: "advance", minutes: minute - time });
      time = minute;
    }
  };
  const take = (decisionId: string) => {
    actions.push(decide(decisionId));
    time += scenario.decisions.find((decision) => decision.id === decisionId)?.duration ?? 0;
  };

  at(3);
  spec.investigations.forEach(take);
  for (const mitigation of spec.mitigations) take(mitigation);
  if (spec.rateLimit?.start === 20) take("tighten-rate-limit"), take("tighten-rate-limit");
  for (let i = 0; i < spec.earlyScaleOuts; i++) take("scale-application");
  if (spec.rateLimit?.relax === "gradually") {
    // One step a minute once the cache (if any) has had time to warm.
    for (let i = 0; i < 7; i++) {
      at(Math.max(time, 8 + i));
      take("relax-rate-limit");
      if (i < spec.lateScaleOuts) take("scale-application");
    }
  } else {
    for (let i = 0; i < spec.lateScaleOuts; i++) {
      at(Math.max(time, 9 + i));
      take("scale-application");
    }
  }
  if (spec.rateLimit?.relax === "after-peak") {
    at(Math.max(time, 25));
    for (let i = 0; i < 8; i++) take("relax-rate-limit");
  }
  if (spec.cleanup) {
    at(Math.max(time, 30));
    if (spec.mitigations.includes("add-database-replica")) take("remove-database-replica");
    if (spec.mitigations.includes("upgrade-database")) take("downgrade-database");
    // Trim one step a minute; refused steps (application too busy) are part of the plan.
    for (let i = 0; i < 6; i++) {
      at(Math.max(time, 31 + i));
      take("scale-down-application");
    }
  }
  return actions;
}

export function planName(spec: PlanSpec): string {
  const short: Record<string, string> = {
    "investigate-traffic": "inv-traffic",
    "investigate-database": "inv-db",
    "enable-cache": "cache",
    "add-database-replica": "replica",
    "upgrade-database": "upgrade",
    "enable-async-writes": "async",
    "enable-rate-limiting": "rate-limit",
  };
  const parts = [
    spec.investigations.map((id) => short[id]).join("+") || "act-now",
    spec.mitigations.map((id) => short[id]).join("+") || "no-mitigation",
  ];
  if (spec.rateLimit) parts.push(`limit ${spec.rateLimit.start}K/${spec.rateLimit.relax}`);
  parts.push(`scale ${spec.earlyScaleOuts}+${spec.lateScaleOuts}`);
  parts.push(spec.cleanup ? "cleanup" : "no-cleanup");
  return parts.join(" · ");
}

export function evaluatePlan(spec: PlanSpec, scenario: Scenario = createScenario(trafficIncidentScenario)): PlanResult {
  const simulation = replay(scenario, planActions(spec, scenario));
  if (!simulation.isComplete()) simulation.runToCompletion();
  const { summary, impact, cost, architecture, decisions } = simulation.getPostmortem();
  return {
    name: planName(spec),
    spec,
    applied: decisions.map((record) => `${record.decisionId}@${record.timestamp}`).join(" "),
    outcome: summary.outcome,
    score: summary.score,
    failedRequests: impact.failedRequests,
    throttledRequests: impact.throttledRequests,
    sloViolationMinutes: impact.sloViolationMinutes,
    peakP99: Math.round(impact.peakP99Latency),
    finalMonthlyCost: cost.finalMonthlyCost,
    incidentSpend: cost.incidentSpend,
    complexity: architecture.final.complexityScore,
    timeToStabilize: summary.timeToStabilize ?? summary.duration,
    businessImpact: impact.businessImpact ?? 0,
    availability: impact.availability,
  };
}

/** Every plan in the search space. */
export function allPlans(): PlanSpec[] {
  const plans: PlanSpec[] = [];
  for (const investigations of INVESTIGATIONS) {
    for (let mask = 0; mask < 1 << MITIGATIONS.length; mask++) {
      const mitigations = MITIGATIONS.filter((_, index) => mask & (1 << index));
      const rateLimits = mitigations.includes("enable-rate-limiting") ? RATE_LIMITS : [null];
      for (const rateLimit of rateLimits) {
        for (let earlyScaleOuts = 0; earlyScaleOuts <= 3; earlyScaleOuts++) {
          for (let lateScaleOuts = 0; lateScaleOuts <= 3; lateScaleOuts++) {
            for (const cleanup of [false, true]) plans.push({ investigations, mitigations, rateLimit, earlyScaleOuts, lateScaleOuts, cleanup });
          }
        }
      }
    }
  }
  return plans;
}

export function dominates(a: PlanResult, b: PlanResult): boolean {
  return PARETO_KEYS.every((key) => a[key] <= b[key]) && PARETO_KEYS.some((key) => a[key] < b[key]);
}

/** Plans no other plan beats on every objective at once. */
export function paretoFront(results: readonly PlanResult[]): PlanResult[] {
  return results.filter((plan) => !results.some((other) => dominates(other, plan)));
}

export interface Landscape {
  results: PlanResult[];
  front: PlanResult[];
  counts: Record<PlanResult["outcome"], number>;
  /** Plans that are at least as good as every other plan on every objective. */
  dominant: PlanResult[];
}

export function explore(plans: readonly PlanSpec[] = allPlans()): Landscape {
  const scenario = createScenario(trafficIncidentScenario);
  const distinct = new Map<string, PlanResult>();
  for (const spec of plans) {
    const result = evaluatePlan(spec, scenario);
    if (!distinct.has(result.applied)) distinct.set(result.applied, result);
  }
  const results = [...distinct.values()];
  const front = paretoFront(results);
  const counts = { success: 0, partial: 0, failure: 0 };
  for (const result of results) counts[result.outcome]++;
  const dominant = front.filter((plan) => results.every((other) => other === plan || PARETO_KEYS.every((key) => plan[key] <= other[key])));
  return { results, front, counts, dominant };
}

if (import.meta.main) {
  const started = Date.now();
  const { results, front, counts, dominant } = explore();
  const millions = (value: number) => `${(value / 1e6).toFixed(1)}M`;
  console.log(`Explored ${allPlans().length} plans (${results.length} distinct after refused steps) in ${((Date.now() - started) / 1000).toFixed(1)} s: success ${counts.success}, partial ${counts.partial}, failure ${counts.failure}`);
  console.log(`Pareto frontier over ${PARETO_KEYS.join(", ")}: ${front.length} plans (${front.filter((plan) => plan.outcome === "success").length} successful)`);
  console.log(`Pareto frontier among successful plans only: ${paretoFront(results.filter((plan) => plan.outcome === "success")).length} plans`);
  console.log(`Plans dominating every other plan: ${dominant.length}\n`);

  const row = (plan: PlanResult) =>
    `| ${plan.name} | ${plan.outcome} | ${plan.score} | ${millions(plan.failedRequests)} | ${millions(plan.throttledRequests)} | ${plan.sloViolationMinutes} | ${plan.peakP99} ms | $${plan.finalMonthlyCost.toFixed(0)} | $${plan.incidentSpend.toFixed(2)} | ${plan.complexity} | ${plan.timeToStabilize} | $${Math.round(plan.businessImpact).toLocaleString("en-US")} |`;
  const header = "| Plan | Outcome | Score | Failed | Throttled | SLO-violation min | Peak p99 | Cost/month | Incident spend | Complexity | Time to stabilize | Business impact |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";

  console.log("Best plan per objective among plans that did not fail (ties broken by score):\n");
  console.log(header);
  const defensible = results.filter((plan) => plan.outcome !== "failure");
  for (const key of PARETO_KEYS) {
    const best = [...defensible].sort((a, b) => a[key] - b[key] || b.score - a.score)[0]!;
    console.log(row({ ...best, name: `**${key}**: ${best.name}` }));
  }
  console.log("\nTop successful plans by score:\n");
  console.log(header);
  for (const plan of results.filter((plan) => plan.outcome === "success").sort((a, b) => b.score - a.score).slice(0, 12)) console.log(row(plan));

  const share = (predicate: (plan: PlanResult) => boolean, pool: readonly PlanResult[]) => `${pool.filter(predicate).length}/${pool.length}`;
  const successes = results.filter((plan) => plan.outcome === "success");
  console.log("\nWhat successful plans have in common:\n");
  for (const mitigation of MITIGATIONS) console.log(`- ${mitigation}: ${share((plan) => plan.spec.mitigations.includes(mitigation), successes)}`);
  console.log(`- investigated first: ${share((plan) => plan.spec.investigations.length > 0, successes)}`);
  console.log(`- cleaned up after the peak: ${share((plan) => plan.spec.cleanup, successes)}`);

  console.log("\nOutcomes by mitigation set (success / partial / failure):\n");
  const byMitigations = new Map<string, Record<PlanResult["outcome"], number>>();
  for (const plan of results) {
    const key = plan.spec.mitigations.filter((id) => plan.applied.includes(id)).join("+") || "none";
    const tally = byMitigations.get(key) ?? { success: 0, partial: 0, failure: 0 };
    tally[plan.outcome]++;
    byMitigations.set(key, tally);
  }
  for (const [key, tally] of [...byMitigations].sort((a, b) => b[1].success - a[1].success || b[1].partial - a[1].partial)) {
    console.log(`- ${key}: ${tally.success} / ${tally.partial} / ${tally.failure}`);
  }
}
