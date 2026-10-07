/** Raised when a scenario definition is malformed. Lists every problem found. */
export class ScenarioValidationError extends Error {
  readonly issues: string[];

  constructor(scenarioId: string, issues: string[]) {
    super(`Scenario "${scenarioId}" is invalid:\n- ${issues.join("\n- ")}`);
    this.name = "ScenarioValidationError";
    this.issues = issues;
  }
}

/** Raised when an effect cannot be applied to the current state. */
export class EffectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EffectError";
  }
}

/** Raised when the simulation is used incorrectly, e.g. advancing a finished run. */
export class SimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationError";
  }
}
