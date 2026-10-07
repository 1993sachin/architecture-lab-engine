/**
 * Plays a playbook against "The 10× Traffic Incident" minute by minute and
 * prints the timeline and the postmortem.
 *
 *   npm run example          # strategy C, "Cache first"
 *   npm run example -- B     # any of A–E (see tests/support/strategies.ts)
 */
import { createScenario, createSimulation, formatMetric, formatTime, formatUsd, trafficIncidentScenario, type SystemState } from "../src/index.ts";
import { STRATEGIES } from "../tests/support/strategies.ts";

const strategy = STRATEGIES.find((candidate) => candidate.id === (process.argv[2] ?? "C").toUpperCase());
if (!strategy) throw new Error(`Unknown strategy. Choose one of ${STRATEGIES.map((candidate) => candidate.id).join(", ")}.`);

const scenario = createScenario(trafficIncidentScenario);
const simulation = createSimulation(scenario);

function show(state: SystemState): void {
  const m = state.metrics;
  console.log(
    `${formatTime(state.time).padEnd(6)}`,
    `rps ${String(m.requestsPerSecond).padStart(7)}`,
    `| p99 ${formatMetric("p99Latency", m.p99Latency ?? 0).padStart(10)}`,
    `| errors ${formatMetric("serverErrorRate", m.serverErrorRate ?? 0).padStart(7)}`,
    `| throttled ${formatMetric("throttleRate", m.throttleRate ?? 0).padStart(7)}`,
    `| app CPU ${formatMetric("cpuUtilization", m.cpuUtilization ?? 0).padStart(8)}`,
    `| ${formatMetric("monthlyCost", m.monthlyCost ?? 0)}`,
  );
}

console.log(`${scenario.title}: playbook ${strategy.id}, "${strategy.name}"\n${strategy.summary}\n`);
show(simulation.getState());
const steps = [...strategy.steps];
while (!simulation.isComplete()) {
  const now = simulation.getState().time;
  while (steps[0] && steps[0].at <= now) {
    const step = steps.shift()!;
    const outcome = simulation.chooseDecision(step.decision, { rationale: step.rationale });
    if (outcome.status === "applied") {
      console.log(`  → ${outcome.record.title}: "${step.rationale}"`);
      for (const value of outcome.record.revealed) console.log(`    🔎 ${value.text}`);
    } else {
      console.log(`  ✗ ${step.decision} is ${outcome.status}: ${outcome.reason}`);
    }
    if (simulation.isComplete()) break;
  }
  if (simulation.isComplete()) break;
  if (simulation.getState().time > now) continue; // an investigation took time
  const report = simulation.advance(1);
  for (const event of report.events) console.log(`  ⚡ ${event.title}: ${event.description}`);
  show(report.state);
}

const postmortem = simulation.getPostmortem();
const { summary, impact, cost } = postmortem;
console.log(`\nOutcome: ${summary.outcome} (score ${summary.score})`);
console.log(`Incident started ${summary.incidentStartedAt === null ? "never" : formatTime(summary.incidentStartedAt)}, stabilized ${summary.stabilizedAt === null ? "never" : formatTime(summary.stabilizedAt)}`);
console.log(
  `Requests: ${impact.successfulRequests.toLocaleString("en-US")} served, ${impact.failedRequests.toLocaleString("en-US")} failed, ${impact.throttledRequests.toLocaleString("en-US")} throttled`,
);
console.log(`SLOs violated for ${impact.sloViolationMinutes} min; business impact ${formatUsd(impact.businessImpact ?? 0)}`);
console.log(`Run-rate ${formatUsd(cost.initialMonthlyCost)} → ${formatUsd(cost.finalMonthlyCost)}/month; incident spend ${formatUsd(cost.incidentSpend)}`);
console.log("\nObjectives:");
for (const objective of postmortem.objectives) console.log(`  ${objective.met ? "✓" : "✗"} ${objective.description} (${Math.round(objective.achieved * 100)}%)`);
console.log("\nLearning signals:");
for (const signal of postmortem.learningSignals) console.log(`  ${signal.assessment === "strength" ? "+" : signal.assessment === "weakness" ? "-" : "·"} ${signal.id}: ${signal.detail}`);
