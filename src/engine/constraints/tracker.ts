import type { ConstraintCheck, ConstraintViolation, SystemState } from "../../types/index.ts";

/** Turns per-tick constraint checks into violation periods (start, end, worst value). */
export class ViolationTracker {
  #open = new Map<string, ConstraintViolation>();
  #all: ConstraintViolation[] = [];

  update(state: SystemState, checks: readonly ConstraintCheck[]): void {
    const failing = new Set<string>();
    for (const check of checks) {
      if (check.satisfied) continue;
      failing.add(check.constraintId);
      const open = this.#open.get(check.constraintId);
      if (open) {
        open.message = check.message;
        if (check.actual !== undefined) open.worstValue = worst(open, check.actual);
        continue;
      }
      const constraint = state.constraints.find((candidate) => candidate.id === check.constraintId);
      const violation: ConstraintViolation = {
        constraintId: check.constraintId,
        kind: check.kind,
        description: constraint?.description ?? check.constraintId,
        message: check.message,
        startedAt: state.time,
        endedAt: null,
      };
      if (check.limit !== undefined) violation.limit = check.limit;
      if (check.actual !== undefined) violation.worstValue = check.actual;
      this.#open.set(check.constraintId, violation);
      this.#all.push(violation);
    }
    for (const [id, violation] of this.#open) {
      if (failing.has(id)) continue;
      violation.endedAt = state.time;
      this.#open.delete(id);
    }
  }

  violations(): ConstraintViolation[] {
    return structuredClone(this.#all);
  }
}

function worst(violation: ConstraintViolation, actual: number): number {
  const previous = violation.worstValue ?? actual;
  const lowerIsWorse = violation.kind === "metric" && violation.limit !== undefined && previous < violation.limit;
  return lowerIsWorse ? Math.min(previous, actual) : Math.max(previous, actual);
}
