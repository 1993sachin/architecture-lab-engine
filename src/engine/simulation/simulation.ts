import type {
  Constraint,
  Consequence,
  DecisionOption,
  DecisionOutcome,
  DecisionPreview,
  DecisionRecord,
  DecisionValidation,
  EndReason,
  FiredEvent,
  HistoryEntry,
  MetricSample,
  ObservedValue,
  Postmortem,
  Scenario,
  SimulationAction,
  SimulationHistory,
  SimulationResult,
  SystemState,
} from "../../types/index.ts";
import type { ConditionContext } from "../conditions/evaluate.ts";
import { evaluateCondition } from "../conditions/evaluate.ts";
import { checkConstraints } from "../constraints/check.ts";
import { ViolationTracker } from "../constraints/tracker.ts";
import { subtractCosts, totalCost } from "../costs/cost.ts";
import { applyDecision } from "../decisions/apply.ts";
import { previewDecision, validateDecision, type DecisionContext } from "../decisions/validate.ts";
import { applyEffectsInPlace } from "../effects/apply.ts";
import { EffectError, SimulationError } from "../errors.ts";
import { dueEvents } from "../events/process.ts";
import { diffStates } from "../history/consequences.ts";
import { calculateMetricsInPlace } from "../metrics/calculate.ts";
import { observe } from "../observations/observe.ts";
import { ObjectiveTracker } from "../scoring/objectives.ts";
import { createPostmortem } from "../scoring/postmortem.ts";
import { buildResult } from "../scoring/result.ts";
import { cloneState } from "../state/clone.ts";
import { round } from "../state/numeric.ts";
import { applyOngoingEffects, type ActiveOngoingEffect } from "./ongoing.ts";
import { advanceTime } from "./time.ts";

export interface ChooseDecisionOptions {
  /** Why the engineer chose this. Preserved verbatim in the decision record. */
  rationale: string;
}

export interface AdvanceReport {
  from: number;
  to: number;
  events: FiredEvent[];
  consequences: Consequence[];
  state: SystemState;
  complete: boolean;
}

export interface Simulation {
  readonly scenario: Scenario;
  /** A copy of the current system state. */
  getState(): SystemState;
  /** Current logical time in minutes. */
  getTime(): number;
  /** What the engineer can currently observe. Investigation decisions reveal more. */
  getObservations(): ObservedValue[];
  /** Every decision in the scenario with its current validation status. */
  getDecisions(): DecisionOption[];
  validateDecision(decisionId: string): DecisionValidation;
  /** Projected outcome of a decision, or `null` if it cannot be applied. */
  previewDecision(decisionId: string): DecisionPreview | null;
  /** Validates and, if valid, applies a decision. Rejections are returned and recorded, never applied. */
  chooseDecision(decisionId: string, options: ChooseDecisionOptions): DecisionOutcome;
  /** Moves logical time forward. Defaults to one tick. Stops early if the scenario completes. */
  advance(minutes?: number): AdvanceReport;
  /** Advances until the scenario completes. */
  runToCompletion(): AdvanceReport;
  isComplete(): boolean;
  getHistory(): SimulationHistory;
  /** The structured result. Available at any time; `complete` says whether the run has ended. */
  getResult(): SimulationResult;
  /** Structured postmortem data: summary, impact, decisions, constraints, architecture, learning signals. */
  getPostmortem(): Postmortem;
}

export function createSimulation(scenario: Scenario): Simulation {
  return new DeterministicSimulation(scenario);
}

/** Re-runs a recorded action sequence. The same scenario and actions always give the same result. */
export function replay(scenario: Scenario, actions: readonly SimulationAction[]): Simulation {
  const simulation = createSimulation(scenario);
  for (const action of actions) {
    if (action.type === "decide") simulation.chooseDecision(action.decisionId, { rationale: action.rationale });
    else simulation.advance(action.minutes);
  }
  return simulation;
}

/**
 * Orchestrates the pipeline. Each step lives in its own module:
 *
 *   decision: validate → apply immediate effects → calculate metrics → consequences
 *   tick:     advance time → ongoing effects → events → calculate metrics → constraints → consequences
 *
 * All state is plain data and every step is a deterministic function of its inputs.
 */
class DeterministicSimulation implements Simulation {
  readonly scenario: Scenario;
  #state: SystemState;
  #decisionsTaken: string[] = [];
  #firedEvents = new Set<string>();
  #ongoing: ActiveOngoingEffect[] = [];
  #entries: HistoryEntry[] = [];
  #decisions: DecisionRecord[] = [];
  #events: FiredEvent[] = [];
  #samples: MetricSample[] = [];
  #actions: SimulationAction[] = [];
  #consequences: Consequence[] = [];
  #consequenceCount = 0;
  #violations = new ViolationTracker();
  #objectives: ObjectiveTracker;
  #endReason: EndReason = "inProgress";
  #visible: Set<string>;
  #currentViolations: string[] = [];
  #knownConstraints = new Map<string, string>();

  constructor(scenario: Scenario) {
    this.scenario = scenario;
    this.#objectives = new ObjectiveTracker(scenario.objectives);
    this.#visible = new Set(scenario.observations.filter((observation) => observation.visible !== false).map((observation) => observation.id));
    this.#state = cloneState(scenario.initialState);
    // Events scheduled for T+0 shape the starting situation.
    this.#processEvents(this.#state);
    calculateMetricsInPlace(this.#state, scenario.metrics);
    this.#observe(0);
    this.#sample(0);
  }

  getObservations(): ObservedValue[] {
    return this.scenario.observations
      .filter((observation) => this.#visible.has(observation.id))
      .map((observation) => observe(observation, this.#state));
  }

  getState(): SystemState {
    return cloneState(this.#state);
  }

  getTime(): number {
    return this.#state.time;
  }

  isComplete(): boolean {
    return this.#endReason !== "inProgress";
  }

  getDecisions(): DecisionOption[] {
    return this.scenario.decisions.map((decision) => ({
      decision: structuredClone(decision),
      validation: this.validateDecision(decision.id),
    }));
  }

  validateDecision(decisionId: string): DecisionValidation {
    if (this.isComplete()) {
      const reasons = ["The scenario has ended."];
      return { status: "unavailable", decisionId, reason: reasons[0] as string, reasons };
    }
    return validateDecision(this.#decisionContext(), decisionId);
  }

  previewDecision(decisionId: string): DecisionPreview | null {
    const decision = this.scenario.decisions.find((candidate) => candidate.id === decisionId);
    if (!decision) return null;
    try {
      return previewDecision(this.#decisionContext(), decision);
    } catch (error) {
      if (error instanceof EffectError) return null;
      throw error;
    }
  }

  chooseDecision(decisionId: string, options: ChooseDecisionOptions): DecisionOutcome {
    const rationale = options.rationale;
    this.#actions.push({ type: "decide", decisionId, rationale });

    const validation = this.validateDecision(decisionId);
    if (validation.status !== "valid") {
      this.#entries.push({
        type: "rejectedDecision",
        time: this.#state.time,
        decisionId,
        status: validation.status,
        reasons: validation.reasons,
        rationale,
      });
      return { status: validation.status, decisionId, reason: validation.reason, reasons: validation.reasons };
    }

    const decision = this.scenario.decisions.find((candidate) => candidate.id === decisionId);
    if (!decision) throw new SimulationError(`Decision "${decisionId}" disappeared after validation.`);

    const knowledge = this.getObservations();
    const before = this.#state;
    const application = applyDecision(before, decision, this.#decisionsTaken, this.scenario.metrics);
    this.#state = application.state;
    this.#decisionsTaken.push(decisionId);
    for (const effect of application.ongoingEffects) {
      this.#ongoing.push({ sourceId: decisionId, effect, startedAt: this.#state.time });
    }

    for (const id of decision.reveals ?? []) this.#visible.add(id);
    const revealed = this.scenario.observations
      .filter((observation) => decision.reveals?.includes(observation.id))
      .map((observation) => observe(observation, this.#state));

    const consequences = diffStates(before, this.#state, { kind: "decision", decisionId }, () => this.#nextConsequenceId());
    this.#consequences.push(...consequences);
    const record: DecisionRecord = {
      sequence: this.#decisions.length + 1,
      decisionId,
      title: decision.title,
      timestamp: this.#state.time,
      rationale,
      knowledge,
      revealed,
      stateBefore: cloneState(before),
      stateAfter: cloneState(this.#state),
      costImpact: subtractCosts(totalCost(this.#state), totalCost(before)),
      complexityImpact: round(this.#state.complexityScore - before.complexityScore, 2),
      consequences,
      sideEffects: application.sideEffects,
    };
    this.#decisions.push(record);
    this.#entries.push({ type: "decision", time: this.#state.time, record });
    this.#observe(0);
    // Time the team spends on the decision; the world moves on meanwhile.
    if (decision.duration && !this.isComplete()) this.#advance(decision.duration);
    return { status: "applied", record: structuredClone(record) };
  }

  advance(minutes: number = this.scenario.timeStep): AdvanceReport {
    const step = this.scenario.timeStep;
    if (!(Number.isInteger(minutes) && minutes > 0 && minutes % step === 0)) {
      throw new SimulationError(`Can only advance by a positive multiple of the time step (${step} min); got ${minutes}.`);
    }
    if (this.isComplete()) throw new SimulationError("The scenario has ended; it cannot advance further.");
    this.#actions.push({ type: "advance", minutes });
    return this.#advance(minutes);
  }

  #advance(minutes: number): AdvanceReport {
    const step = this.scenario.timeStep;
    const before = this.#state;
    const fired: FiredEvent[] = [];
    const causes: string[] = [];
    for (let elapsed = 0; elapsed < minutes && !this.isComplete(); elapsed += step) {
      const tick = this.#tick(step);
      fired.push(...tick.events);
      for (const cause of tick.causes) if (!causes.includes(cause)) causes.push(cause);
    }

    const consequences = diffStates(
      before,
      this.#state,
      { kind: "progression", from: before.time, to: this.#state.time, causes },
      () => this.#nextConsequenceId(),
    );
    this.#consequences.push(...consequences);
    this.#entries.push({ type: "advance", from: before.time, to: this.#state.time, consequences });
    return {
      from: before.time,
      to: this.#state.time,
      events: structuredClone(fired),
      consequences: structuredClone(consequences),
      state: this.getState(),
      complete: this.isComplete(),
    };
  }

  runToCompletion(): AdvanceReport {
    const remaining = this.scenario.completion.maxDuration - this.#state.time;
    if (remaining <= 0 || this.isComplete()) throw new SimulationError("The scenario has ended; it cannot advance further.");
    return this.advance(remaining);
  }

  getHistory(): SimulationHistory {
    return structuredClone(this.#history());
  }

  getResult(): SimulationResult {
    return structuredClone(this.#result());
  }

  getPostmortem(): Postmortem {
    // Built from internal data and copied once: decision records carry full states.
    return structuredClone(createPostmortem(this.scenario, this.#result(), this.#history()));
  }

  #history(): SimulationHistory {
    return { entries: this.#entries, decisions: this.#decisions, events: this.#events, samples: this.#samples, actions: this.#actions };
  }

  #result(): SimulationResult {
    return buildResult({
        scenarioId: this.scenario.id,
        objectives: this.scenario.objectives,
        objectiveResults: this.#objectives.results(this.#conditionContext()),
        finalState: this.#state,
        complete: this.isComplete(),
        endReason: this.#endReason,
        samples: this.#samples,
        decisions: this.#decisions,
        consequences: this.#consequences,
        violations: this.#violations.violations(),
        businessImpact: this.scenario.businessImpact,
    });
  }

  /** One tick of the pipeline. */
  #tick(minutes: number): { events: FiredEvent[]; causes: string[] } {
    const draft = cloneState(this.#state);

    advanceTime(draft, minutes);

    const ongoing = applyOngoingEffects(draft, this.#ongoing, this.#decisionsTaken);
    this.#ongoing = ongoing.active;

    calculateMetricsInPlace(draft, this.scenario.metrics);
    const events = this.#processEvents(draft);

    calculateMetricsInPlace(draft, this.scenario.metrics);
    this.#state = draft;
    this.#observe(minutes);
    this.#sample(minutes);

    return { events, causes: [...events.map((event) => `event:${event.eventId}`), ...ongoing.applied.map((id) => `ongoing:${id}`)] };
  }

  #processEvents(draft: SystemState): FiredEvent[] {
    const fired: FiredEvent[] = [];
    const due = dueEvents(this.scenario.events, { state: draft, decisionsTaken: this.#decisionsTaken }, this.#firedEvents);
    for (const event of due) {
      try {
        applyEffectsInPlace(draft, event.effects);
      } catch (error) {
        if (error instanceof EffectError) throw new SimulationError(`Event "${event.id}" could not be applied: ${error.message}`);
        throw error;
      }
      for (const effect of event.ongoingEffects ?? []) {
        this.#ongoing.push({ sourceId: event.id, effect, startedAt: draft.time });
      }
      this.#firedEvents.add(event.id);
      const record: FiredEvent = { eventId: event.id, title: event.title, description: event.description, time: draft.time };
      fired.push(record);
      this.#events.push(record);
      this.#entries.push({ type: "event", time: draft.time, event: record });
    }
    return fired;
  }

  /** Checks constraints, objectives and completion against the current state. */
  #observe(minutes: number): void {
    this.#recordConstraintChanges();
    const context = this.#conditionContext();
    const checks = checkConstraints(context);
    this.#currentViolations = checks.filter((check) => !check.satisfied).map((check) => check.constraintId);
    this.#violations.update(this.#state, checks);
    this.#objectives.observe(context, minutes);

    const { completion } = this.scenario;
    if (completion.failWhen && evaluateCondition(completion.failWhen, context)) this.#endReason = "failCondition";
    else if (completion.endWhen && evaluateCondition(completion.endWhen, context)) this.#endReason = "endCondition";
    else if (this.#state.time >= completion.maxDuration) this.#endReason = "maxDuration";
  }

  #recordConstraintChanges(): void {
    const time = this.#state.time;
    const current = new Map(this.#state.constraints.map((constraint) => [constraint.id, constraint]));
    for (const [id, constraint] of current) {
      const serialized = JSON.stringify(constraint);
      const known = this.#knownConstraints.get(id);
      if (known === serialized) continue;
      this.#entries.push({ type: "constraint", time, change: known === undefined ? "added" : "updated", constraint: structuredClone(constraint) });
      this.#knownConstraints.set(id, serialized);
    }
    for (const [id, serialized] of [...this.#knownConstraints]) {
      if (current.has(id)) continue;
      this.#entries.push({ type: "constraint", time, change: "removed", constraint: JSON.parse(serialized) as Constraint });
      this.#knownConstraints.delete(id);
    }
  }

  /** Records the state at the end of an interval of `minutes`. */
  #sample(minutes: number): void {
    const seconds = minutes * 60;
    const throttled = this.#state.components.reduce((sum, component) => sum + component.load.throttled, 0);
    const errorRate = this.#state.metrics.errorRate ?? 0;
    this.#samples.push({
      time: this.#state.time,
      metrics: { ...this.#state.metrics },
      complexityScore: this.#state.complexityScore,
      monthlyCost: totalCost(this.#state).monthly,
      violations: [...this.#currentViolations],
      requests: round(this.#state.workload.requestsPerSecond * seconds, 2),
      failedRequests: round(Math.max(0, this.#state.workload.requestsPerSecond * errorRate - throttled) * seconds, 2),
      throttledRequests: round(throttled * seconds, 2),
    });
  }

  #conditionContext(): ConditionContext {
    return { state: this.#state, decisionsTaken: this.#decisionsTaken };
  }

  #decisionContext(): DecisionContext {
    return {
      state: this.#state,
      decisions: this.scenario.decisions,
      decisionsTaken: this.#decisionsTaken,
      tracked: this.scenario.metrics,
    };
  }

  #nextConsequenceId(): string {
    this.#consequenceCount += 1;
    return `consequence-${this.#consequenceCount}`;
  }
}
