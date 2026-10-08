import {
  createScenario,
  playbookActions,
  replay,
  trafficIncidentPlaybooks,
  trafficIncidentScenario,
  type Playbook,
  type Scenario,
  type Simulation,
  type SimulationResult,
} from "../../src/index.ts";

export type { Playbook as Strategy, PlaybookStep as StrategyStep } from "../../src/index.ts";

/** The playbooks shipped with the scenario. */
export const STRATEGIES = trafficIncidentPlaybooks;
export const toActions = playbookActions;

/** Plays a strategy to the end of the scenario. */
export function play(strategy: Playbook, scenario: Scenario = createScenario(trafficIncidentScenario)): Simulation {
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

export function summarize(strategy: Playbook, simulation: Simulation): StrategySummary {
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
