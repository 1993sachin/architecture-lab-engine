/** One step of a playbook: at logical time `at`, take `decision` because of `rationale`. */
export interface PlaybookStep {
  at: number;
  decision: string;
  rationale: string;
}

/** A named, timed sequence of decisions, e.g. a reference strategy for a scenario. */
export interface Playbook {
  id: string;
  name: string;
  summary: string;
  steps: PlaybookStep[];
}
