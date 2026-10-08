/**
 * Architecture Lab Engine: a deterministic, UI-independent simulation of
 * architectural decisions and their consequences.
 */
export * from "./types/index.ts";

export { createScenario, defineScenario } from "./engine/scenario/define.ts";
export { playbookActions } from "./engine/scenario/playbooks.ts";
export {
  createSimulation,
  replay,
  type AdvanceReport,
  type ChooseDecisionOptions,
  type Simulation,
} from "./engine/simulation/simulation.ts";
export { formatTime } from "./engine/simulation/time.ts";
export { EffectError, ScenarioValidationError, SimulationError } from "./engine/errors.ts";

// Building blocks, for custom tooling and tests.
export { COMPONENT_CATALOG, type ComponentBehavior, type ComponentTypeDefinition } from "./engine/components/catalog.ts";
export { createComponent, effectiveCapacity } from "./engine/components/factory.ts";
export { dependenciesOf, dependentsOf, topologicalOrder } from "./engine/components/graph.ts";
export { HEALTH_PROFILES, type HealthProfile } from "./engine/components/health.ts";
export { describeCondition, evaluateCondition, type ConditionContext } from "./engine/conditions/evaluate.ts";
export { checkConstraint, checkConstraints } from "./engine/constraints/check.ts";
export { fromHourly, formatUsd, toCost, totalCost, HOURS_PER_MONTH } from "./engine/costs/cost.ts";
export { applyEffects } from "./engine/effects/apply.ts";
export { calculateMetrics } from "./engine/metrics/calculate.ts";
export { METRIC_DEFINITIONS, formatMetric } from "./engine/metrics/definitions.ts";
export { deliveryAttempts, exhaustedRate, overloadErrorRate, queueingFactor } from "./engine/metrics/flow.ts";
export { diffStates } from "./engine/history/consequences.ts";
export { observe } from "./engine/observations/observe.ts";
export { architectureSnapshot, createPostmortem } from "./engine/scoring/postmortem.ts";

export { trafficIncidentScenario } from "./scenarios/10x-traffic-incident.ts";
export { trafficIncidentPlaybooks } from "./scenarios/10x-traffic-incident-playbooks.ts";
export { queueWontDrainScenario } from "./scenarios/queue-wont-drain.ts";
export { queueWontDrainPlaybooks } from "./scenarios/queue-wont-drain-playbooks.ts";
