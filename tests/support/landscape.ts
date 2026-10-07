/**
 * Explores the decision space of "The 10× Traffic Incident" by brute force:
 * every combination of the main mitigations, 0–5 scale-outs, reacting at T+3
 * or T+6, optionally relaxing the rate limit, and trimming capacity once
 * traffic settles. Reports outcomes and the Pareto front.
 *
 *   npm run report:landscape
 */
import { createScenario, replay, trafficSpikeScenario, type SimulationAction } from "../../src/index.ts";

const scenario = createScenario(trafficSpikeScenario);
const MITIGATIONS = ["enable-cache", "enable-rate-limiting", "add-database-replica", "increase-database-capacity", "enable-async-processing"];

interface Plan {
  name: string;
  outcome: string;
  score: number;
  failedRequests: number;
  minutesInViolation: number;
  peakP95: number;
  monthlyCost: number;
  complexity: number;
}

const decide = (decisionId: string): SimulationAction => ({ type: "decide", decisionId, rationale: "landscape exploration" });
const plans = new Map<string, Plan>();
for (let mask = 0; mask < 1 << MITIGATIONS.length; mask++) {
  const picks = MITIGATIONS.filter((_, index) => mask & (1 << index));
  for (let scaleOuts = 0; scaleOuts <= 5; scaleOuts++) {
    for (const reactAt of [3, 6]) {
      for (const relax of picks.includes("enable-rate-limiting") ? [0, 2] : [0]) {
        const actions: SimulationAction[] = [{ type: "advance", minutes: reactAt }];
        for (let i = 0; i < scaleOuts; i++) actions.push(decide("scale-application"));
        actions.push(...picks.map(decide), { type: "advance", minutes: 15 - reactAt });
        for (let i = 0; i < relax; i++) actions.push(decide("relax-rate-limiting"));
        actions.push({ type: "advance", minutes: 21 });
        for (let i = 0; i < 6; i++) actions.push(decide("scale-down-application"));

        const simulation = replay(scenario, actions);
        if (!simulation.isComplete()) simulation.runToCompletion();
        const result = simulation.getResult();
        const applied = result.decisions.map((record) => record.decisionId);
        const count = (id: string) => applied.filter((decisionId) => decisionId === id).length;
        const name = `T+${reactAt} scale×${count("scale-application")} ${picks.filter((id) => applied.includes(id)).join("+") || "-"} relax×${count("relax-rate-limiting")} trim×${count("scale-down-application")}`;
        plans.set(name, {
          name,
          outcome: result.outcome,
          score: result.score,
          failedRequests: result.impact.failedRequests,
          minutesInViolation: result.impact.minutesInViolation,
          peakP95: Math.round(Math.max(...simulation.getHistory().samples.map((sample) => sample.metrics.p95Latency ?? 0))),
          monthlyCost: result.metrics.totalCost,
          complexity: result.metrics.finalComplexity,
        });
      }
    }
  }
}

const KEYS = ["failedRequests", "minutesInViolation", "peakP95", "monthlyCost", "complexity"] as const;
const dominates = (a: Plan, b: Plan) => KEYS.every((key) => a[key] <= b[key]) && KEYS.some((key) => a[key] < b[key]);
const all = [...plans.values()];
const front = all.filter((plan) => !all.some((other) => dominates(other, plan)));
const count = (outcome: string) => all.filter((plan) => plan.outcome === outcome).length;

console.log(`Distinct plans: ${all.length} (success ${count("success")}, partial ${count("partial")}, failure ${count("failure")})`);
console.log(`Pareto front (failed requests, minutes in violation, peak p95, monthly cost, complexity): ${front.length} plans`);
console.log(`Plans dominating every other plan: ${all.filter((plan) => all.every((other) => other === plan || dominates(plan, other))).length}\n`);
console.log("| Plan | Outcome | Score | Failed requests | Minutes in violation | Peak p95 | Cost/month | Complexity |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const plan of front.sort((a, b) => b.score - a.score || a.failedRequests - b.failedRequests).slice(0, 15)) {
  console.log(
    `| ${plan.name} | ${plan.outcome} | ${plan.score} | ${(plan.failedRequests / 1e6).toFixed(2)}M | ${plan.minutesInViolation} | ${plan.peakP95} ms | $${plan.monthlyCost.toFixed(0)} | ${plan.complexity} |`,
  );
}
