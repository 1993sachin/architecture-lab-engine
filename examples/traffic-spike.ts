/**
 * Plays "The 10× Traffic Incident" from start to finish and prints what happened.
 *
 *   npm run example
 */
import { createScenario, createSimulation, formatMetric, formatTime, trafficSpikeScenario, type SystemState } from "../src/index.ts";

const scenario = createScenario(trafficSpikeScenario);
const simulation = createSimulation(scenario);

function show(label: string, state: SystemState): void {
  const m = state.metrics;
  console.log(
    `${formatTime(state.time).padEnd(10)} ${label.padEnd(30)}`,
    `rps ${String(m.requestsPerSecond).padStart(6)}`,
    `| p95 ${formatMetric("p95Latency", m.p95Latency ?? 0).padStart(10)}`,
    `| errors ${formatMetric("errorRate", m.errorRate ?? 0).padStart(7)}`,
    `| db ${formatMetric("databaseUtilization", m.databaseUtilization ?? 0).padStart(7)}`,
    `| ${formatMetric("monthlyCost", m.monthlyCost ?? 0)}`,
  );
}

console.log(`${scenario.title}\n${scenario.description}\n`);
show("Start", simulation.getState());

const spike = simulation.advance(5);
for (const event of spike.events) console.log(`  ⚡ ${event.title}: ${event.description}`);
show("After the spike", spike.state);

const decide = (decisionId: string, rationale: string) => {
  const outcome = simulation.chooseDecision(decisionId, { rationale });
  if (outcome.status === "applied") show(outcome.record.title, outcome.record.stateAfter);
  else console.log(`  ✗ ${decisionId} is ${outcome.status}: ${outcome.reason}`);
};

decide("scale-application", "Application CPU is at 375%.");
decide("scale-application", "Still above capacity.");
decide("enable-cache", "80% of traffic is reads and the database is now the bottleneck.");
show("Cache warming", simulation.advance(2).state);
decide("enable-rate-limiting", "Shed excess load instead of failing everyone.");
decide("scale-application", "One more round of capacity?");
decide("scale-application", "And another?");

const rest = simulation.runToCompletion();
for (const event of rest.events) console.log(`  ⚡ ${formatTime(event.time)} ${event.title}: ${event.description}`);
show("End", rest.state);

const result = simulation.getResult();
console.log(`\nOutcome: ${result.outcome} (score ${result.score})`);
console.log(`Availability over the run: ${formatMetric("availability", result.metrics.availability)}`);
console.log("\nStrengths:");
for (const line of result.strengths) console.log(`  + ${line}`);
console.log("Weaknesses:");
for (const line of result.weaknesses) console.log(`  - ${line}`);
