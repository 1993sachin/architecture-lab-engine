/**
 * Prints the Phase 1.5 strategy comparison as a Markdown table.
 *
 *   npm run report:strategies
 */
import { createScenario, formatUsd, trafficSpikeScenario } from "../../src/index.ts";
import { STRATEGIES, play, summarize } from "./strategies.ts";

const scenario = createScenario(trafficSpikeScenario);
const rows = STRATEGIES.map((strategy) => {
  const simulation = play(strategy, scenario);
  return { strategy, summary: summarize(strategy, simulation), result: simulation.getResult() };
});

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const millions = (value: number) => `${(value / 1_000_000).toFixed(2)}M`;
const header = [
  "Strategy",
  "Outcome",
  "Score",
  "Peak p95",
  "Peak errors",
  "Availability",
  "Final cost/month",
  "Spend (45 min)",
  "Complexity",
  "Decisions",
  "Stabilized",
  "Failed requests",
  "of which throttled",
  "Minutes in violation",
];
console.log(`| ${header.join(" | ")} |`);
console.log(`|${header.map(() => " --- ").join("|")}|`);
for (const { strategy, summary } of rows) {
  console.log(
    `| ${strategy.id}. ${strategy.name} | ${summary.outcome} | ${summary.score} | ${Math.round(summary.peakP95)} ms | ${pct(summary.peakErrorRate)} | ${pct(summary.availability)} | ${formatUsd(summary.finalMonthlyCost)} | ${formatUsd(summary.spend)} | ${summary.complexity} | ${summary.decisions}${summary.rejected ? ` (+${summary.rejected} rejected)` : ""} | ${summary.stabilizedAt === null ? "never" : `T+${summary.stabilizedAt}`} | ${millions(summary.failedRequests)} | ${millions(summary.throttledRequests)} | ${summary.minutesInViolation} |`,
  );
}

console.log("\nObjectives (achieved fraction):\n");
for (const { strategy, result } of rows) {
  console.log(`- ${strategy.id}: ${result.objectives.map((objective) => `${objective.objectiveId} ${objective.met ? "✓" : "✗"} (${pct(objective.achieved)})`).join(", ")}`);
}
