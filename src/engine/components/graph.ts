import type { Component, Dependency, SystemState } from "../../types/index.ts";

export function outgoing(state: SystemState, componentId: string): Dependency[] {
  return state.dependencies.filter((dependency) => dependency.from === componentId);
}

export function incoming(state: SystemState, componentId: string): Dependency[] {
  return state.dependencies.filter((dependency) => dependency.to === componentId);
}

/** Every component that `componentId` depends on, directly or transitively. */
export function dependenciesOf(state: SystemState, componentId: string): string[] {
  return walk(state, componentId, (id) => outgoing(state, id).map((dependency) => dependency.to));
}

/** Every component that depends on `componentId`, directly or transitively. */
export function dependentsOf(state: SystemState, componentId: string): string[] {
  return walk(state, componentId, (id) => incoming(state, id).map((dependency) => dependency.from));
}

function walk(state: SystemState, start: string, next: (id: string) => string[]): string[] {
  const seen = new Set<string>();
  const stack = [...next(start)];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id) || id === start) continue;
    seen.add(id);
    stack.push(...next(id));
  }
  // Keep component declaration order so results are stable.
  return state.components.map((component) => component.id).filter((id) => seen.has(id));
}

/**
 * Components ordered so every component comes after the ones that call it.
 * Ties keep declaration order, which keeps the calculation deterministic.
 * Returns `null` when the graph has a cycle.
 */
export function topologicalOrder(components: readonly Component[], dependencies: readonly Dependency[]): Component[] | null {
  const indegree = new Map<string, number>();
  for (const component of components) indegree.set(component.id, 0);
  for (const dependency of dependencies) indegree.set(dependency.to, (indegree.get(dependency.to) ?? 0) + 1);

  const ordered: Component[] = [];
  const remaining = [...components];
  while (remaining.length > 0) {
    const index = remaining.findIndex((component) => indegree.get(component.id) === 0);
    if (index === -1) return null;
    const [next] = remaining.splice(index, 1) as [Component];
    ordered.push(next);
    for (const dependency of dependencies) {
      if (dependency.from === next.id) indegree.set(dependency.to, (indegree.get(dependency.to) ?? 0) - 1);
    }
  }
  return ordered;
}

/** Structural problems in a graph: dangling edges, duplicate ids, invalid shares, cycles. */
export function graphIssues(components: readonly Component[], dependencies: readonly Dependency[]): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const component of components) {
    if (ids.has(component.id)) issues.push(`Duplicate component id "${component.id}".`);
    ids.add(component.id);
  }
  const edges = new Set<string>();
  for (const dependency of dependencies) {
    const key = `${dependency.from}->${dependency.to}:${dependency.traffic}`;
    if (!ids.has(dependency.from)) issues.push(`Dependency ${key} starts at unknown component "${dependency.from}".`);
    if (!ids.has(dependency.to)) issues.push(`Dependency ${key} ends at unknown component "${dependency.to}".`);
    if (dependency.from === dependency.to) issues.push(`Dependency ${key} points at itself.`);
    if (!(dependency.share >= 0 && dependency.share <= 1)) issues.push(`Dependency ${key} has share ${dependency.share}; expected 0..1.`);
    if (edges.has(key)) issues.push(`Duplicate dependency ${key}.`);
    edges.add(key);
  }
  if (issues.length === 0 && topologicalOrder(components, dependencies) === null) {
    issues.push("Dependencies contain a cycle.");
  }
  return issues;
}
