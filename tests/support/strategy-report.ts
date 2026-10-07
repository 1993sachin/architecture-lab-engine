/**
 * Plays the five playbooks against "The 10× Traffic Incident" and prints a
 * Markdown comparison.
 *
 *   npm run report:strategies
 */
import { createScenario, formatUsd, trafficIncidentScenario } from "../../src/index.ts";
import { STRATEGIES, play, summarize } from "./strategies.ts";

const scenario = createScenario(trafficIncidentScenario);
const rows = STRATEGIES.map((strategy) => {
  const simulation = play(strategy, scenario);
  return { strategy, summary: summarize(strategy, simulation), result: simulation.getResult() };
});

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const millions = (value: number) => `${(value / 1_000_000).toFixed(1)}M`;
const header = [
  "Strategy",
  "Outcome",
  "Score",
  "Availability",
  "Failed",
  "Throttled",
  "SLO-violation min",
  "Peak p99",
  "Time to stabilize",
  "Final cost/month",
  "Incident spend",
  "Complexity",
  "Business impact",
  "Decisions",
];
console.log(`| ${header.join(" | ")} |`);
console.log(`|${header.map(() => " --- ").join("|")}|`);
for (const { strategy, summary } of rows) {
  console.log(
    `| ${strategy.id}. ${strategy.name} | ${summary.outcome} | ${summary.score} | ${pct(summary.availability)} | ${millions(summary.failedRequests)} | ${millions(summary.throttledRequests)} | ${summary.sloViolationMinutes} | ${Math.round(summary.peakP99)} ms | ${summary.timeToStabilize === null ? "never" : `${summary.timeToStabilize} min`} | ${formatUsd(summary.finalMonthlyCost)} | ${formatUsd(summary.spend)} | ${summary.complexity} | ${formatUsd(summary.businessImpact)} | ${summary.decisions}${summary.rejected ? ` (+${summary.rejected} rejected)` : ""} |`,
  );
}

console.log("\nObjectives (share of the incident each held):\n");
for (const { strategy, result } of rows) {
  console.log(`- ${strategy.id}: ${result.objectives.map((objective) => `${objective.objectiveId} ${objective.met ? "✓" : "✗"} (${pct(objective.achieved)})`).join(", ")}`);
}
