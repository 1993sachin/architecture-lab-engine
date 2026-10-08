/**
 * Explores the decision space of "The Queue That Won't Drain" by brute force
 * and reports outcomes, the Pareto frontier and whether any plan dominates.
 *
 * A plan starts when the operator is paged (T+15): an investigation, then a
 * set of mitigations, plus the follow-ups each one implies (resuming paused
 * work before the deadline, lifting a rate limit, removing extra workers once
 * the backlog is gone).
 *
 *   npm run report:queue-landscape
 */
import { createScenario, createSimulation, queueWontDrainScenario, type Scenario, type SimulationAction } from "../../src/index.ts";

export const QUEUE_MITIGATIONS = ["scale-workers", "upgrade-database", "increase-batch-size", "limit-retries", "pause-low-priority", "enable-rate-limiting"] as const;
export const QUEUE_INVESTIGATIONS = [["investigate-workers"], ["investigate-workers", "investigate-failures", "investigate-database"]] as const;
/** The minute the freshness SLO is first breached, when the operator is paged. */
export const PAGED_AT = 15;

export interface QueuePlanSpec {
  investigations: readonly string[];
  mitigations: readonly string[];
  /** Scale the workers out a second time. */
  secondScaleOut: boolean;
  /** Remove extra workers once the backlog is gone. */
  cleanup: boolean;
}

export interface QueuePlanResult {
  name: string;
  spec: QueuePlanSpec;
  applied: string;
  outcome: "success" | "partial" | "failure";
  score: number;
  finalMonthlyCost: number;
  incidentSpend: number;
  complexity: number;
  sloViolationMinutes: number;
  /** Average processing delay over the run, in seconds. */
  averageDelay: number;
  /** Jobs given up on over the run. */
  failedJobs: number;
  businessImpact: number;
}

/** Lower is better for every key. */
export const QUEUE_PARETO_KEYS = ["finalMonthlyCost", "incidentSpend", "complexity", "sloViolationMinutes", "averageDelay", "failedJobs", "businessImpact"] as const;

export function queuePlanActions(spec: QueuePlanSpec, scenario: Scenario): SimulationAction[] {
  const actions: SimulationAction[] = [];
  let time = 0;
  const at = (minute: number) => {
    if (minute > time) {
      actions.push({ type: "advance", minutes: minute - time });
      time = minute;
    }
  };
  const take = (decisionId: string) => {
    actions.push({ type: "decide", decisionId, rationale: "landscape exploration" });
    time += scenario.decisions.find((decision) => decision.id === decisionId)?.duration ?? 0;
  };
  at(PAGED_AT);
  spec.investigations.forEach(take);
  for (const mitigation of spec.mitigations) {
    take(mitigation);
    if (mitigation === "scale-workers" && spec.secondScaleOut) take(mitigation);
  }
  if (spec.mitigations.includes("enable-rate-limiting")) {
    at(Math.max(time, 30));
    take("remove-rate-limit");
  }
  if (spec.mitigations.includes("pause-low-priority")) {
    at(Math.max(time, 37));
    take("resume-low-priority");
  }
  if (spec.cleanup) {
    for (let i = 0; i < 3; i++) {
      at(Math.max(time, 42 + i));
      take("scale-down-workers");
    }
  }
  return actions;
}

export function allQueuePlans(): QueuePlanSpec[] {
  const plans: QueuePlanSpec[] = [];
  for (let mask = 0; mask < 1 << QUEUE_MITIGATIONS.length; mask++) {
    const mitigations = QUEUE_MITIGATIONS.filter((_, index) => mask & (1 << index));
    for (const investigations of QUEUE_INVESTIGATIONS)
      for (const secondScaleOut of mitigations.includes("scale-workers") ? [false, true] : [false])
        for (const cleanup of [false, true]) plans.push({ investigations, mitigations, secondScaleOut, cleanup });
  }
  return plans;
}

export function evaluateQueuePlan(spec: QueuePlanSpec, scenario: Scenario): QueuePlanResult {
  const simulation = createSimulation(scenario);
  for (const action of queuePlanActions(spec, scenario)) {
    if (simulation.isComplete()) break;
    if (action.type === "decide") simulation.chooseDecision(action.decisionId, { rationale: action.rationale });
    else simulation.advance(action.minutes);
  }
  if (!simulation.isComplete()) simulation.runToCompletion();
  const result = simulation.getResult();
  const samples = simulation.getHistory().samples;
  const failedJobs = samples.reduce((sum, sample) => {
    const { jobFailureRate = 0, processingRate = 0, retryRate = 0 } = sample.metrics;
    return sum + jobFailureRate * processingRate * (1 - retryRate) * 60;
  }, 0);
  const applied = result.decisions.map((record) => `${record.decisionId}@${record.timestamp}`).join(" ");
  const name = [
    ...spec.investigations.map((id) => id.replace("investigate-", "inv-")),
    ...spec.mitigations.map((id) => (id === "scale-workers" && spec.secondScaleOut ? "scale-workers×2" : id)),
    ...(spec.cleanup ? ["cleanup"] : []),
  ].join(" + ");
  return {
    name,
    spec,
    applied,
    outcome: result.outcome,
    score: result.score,
    finalMonthlyCost: result.metrics.totalCost,
    incidentSpend: result.metrics.spend,
    complexity: result.metrics.finalComplexity,
    sloViolationMinutes: result.impact.sloViolationMinutes,
    averageDelay: Math.round(samples.reduce((sum, sample) => sum + (sample.metrics.processingDelay ?? 0), 0) / samples.length),
    failedJobs: Math.round(failedJobs),
    businessImpact: result.impact.businessImpact ?? 0,
  };
}

const dominates = (a: QueuePlanResult, b: QueuePlanResult) => QUEUE_PARETO_KEYS.every((key) => a[key] <= b[key]) && QUEUE_PARETO_KEYS.some((key) => a[key] < b[key]);

export function queueParetoFront(results: readonly QueuePlanResult[]): QueuePlanResult[] {
  return results.filter((plan) => !results.some((other) => dominates(other, plan)));
}

export function exploreQueue(plans: readonly QueuePlanSpec[] = allQueuePlans()) {
  const scenario = createScenario(queueWontDrainScenario);
  const distinct = new Map<string, QueuePlanResult>();
  for (const spec of plans) {
    const result = evaluateQueuePlan(spec, scenario);
    if (!distinct.has(result.applied)) distinct.set(result.applied, result);
  }
  const results = [...distinct.values()];
  const successes = results.filter((plan) => plan.outcome === "success");
  const front = queueParetoFront(successes);
  const counts = { success: 0, partial: 0, failure: 0 };
  for (const result of results) counts[result.outcome]++;
  /** Successful plans at least as good as every other successful plan on every key. */
  const dominant = successes.filter((plan) => successes.every((other) => other === plan || QUEUE_PARETO_KEYS.every((key) => plan[key] <= other[key])));
  return { results, successes, front, counts, dominant };
}

if (import.meta.main) {
  const { results, successes, front, counts, dominant } = exploreQueue();
  console.log(`Explored ${allQueuePlans().length} plans (${results.length} distinct): success ${counts.success}, partial ${counts.partial}, failure ${counts.failure}`);
  console.log(`Pareto frontier among successful plans over ${QUEUE_PARETO_KEYS.join(", ")}: ${front.length} plans`);
  console.log(`Successful plans that dominate every other successful plan: ${dominant.length}\n`);
  const header = "| Plan | Outcome | Score | Cost/month | Spend | Complexity | SLO-violation min | Avg delay | Jobs given up | Business impact |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const row = (plan: QueuePlanResult) =>
    `| ${plan.name} | ${plan.outcome} | ${plan.score} | $${Math.round(plan.finalMonthlyCost)} | $${plan.incidentSpend.toFixed(2)} | ${plan.complexity} | ${plan.sloViolationMinutes} | ${plan.averageDelay} s | ${(plan.failedJobs / 1000).toFixed(0)}k | $${Math.round(plan.businessImpact)} |`;
  console.log("Pareto frontier (successful plans):\n");
  console.log(header);
  for (const plan of [...front].sort((a, b) => b.score - a.score)) console.log(row(plan));
  console.log("\nBest successful plan per objective:\n");
  console.log(header);
  for (const key of QUEUE_PARETO_KEYS) {
    const best = [...successes].sort((a, b) => a[key] - b[key] || b.score - a.score)[0];
    if (best) console.log(row({ ...best, name: `**${key}**: ${best.name}` }));
  }
  const share = (predicate: (plan: QueuePlanResult) => boolean) => `${successes.filter(predicate).length}/${successes.length}`;
  console.log("\nHow often each mitigation appears in successful plans:\n");
  for (const mitigation of QUEUE_MITIGATIONS) console.log(`- ${mitigation}: ${share((plan) => plan.spec.mitigations.includes(mitigation))}`);
}
