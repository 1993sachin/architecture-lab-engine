# Architecture Lab Engine

A deterministic, UI-independent simulation engine for **Architecture Lab**: an environment where engineers practise architectural decisions under changing constraints and see measurable consequences.

```
Situation → Decision → System changes → Consequence → New information / constraint → Another decision → … → Outcome
```

This package is the engine only. It has no UI, no database, no network access, no LLM, and no runtime dependencies. It runs anywhere Node.js runs and is driven from TypeScript code, tests, or (later) a frontend.

## Why it exists

System-design exercises usually stop at a diagram. Architecture Lab wants the next step: make a decision, watch the system respond, deal with what happens next. Doing that credibly needs a model that is

- **explainable**: simple formulas you can read, not a black box;
- **deterministic**: the same decisions always lead to the same outcome, so results can be compared, replayed, and tested;
- **about trade-offs**: every decision moves cost, complexity and behaviour, not just one number;
- **declarative**: scenarios are data, so new ones need no engine changes.

## Quick start

```bash
npm install
npm test          # run the test suite
npm run build     # compile to dist/
npm run example   # play the built-in scenario in the terminal
```

Requires Node.js 22.18+ or 24+ (the example runs TypeScript directly with Node's type stripping).

```ts
import { createScenario, createSimulation, trafficIncidentScenario } from "@architecture-lab/engine";

const scenario = createScenario(trafficIncidentScenario);
const simulation = createSimulation(scenario);

simulation.advance(5);                       // T+5 min: traffic has climbed to 39,000 rps
simulation.getState().metrics.errorRate;     // 0.78: PostgreSQL has collapsed

const outcome = simulation.chooseDecision("enable-cache", {
  rationale: "Read traffic is dominant and database latency is increasing.",
});
if (outcome.status !== "applied") console.log(outcome.reason);

simulation.runToCompletion();
const result = simulation.getResult();       // outcome, metrics, impact, decisions, strengths, weaknesses…
const postmortem = simulation.getPostmortem(); // summary, impact, decisions, constraints, architecture, learning signals
```

## Core concepts

| Concept | What it is | Where |
| --- | --- | --- |
| **Scenario** | The situation: initial system and workload, resources, constraints, decisions, events, objectives, completion conditions. Pure data. | `src/types/scenario.ts`, `src/engine/scenario/` |
| **System state** | Everything about the simulated system at one logical moment: components, dependencies, workload, costs, complexity, resources, flags, constraints, metrics. Plain, serializable data. | `src/types/state.ts` |
| **Component** | A generic building block (`client`, `apiGateway`, `loadBalancer`, `application`, `cache`, `database`, `databaseReplica`, `queue`, `objectStorage`, `cdn`, `worker`) with capacity, instances, health, cost, configuration and calculated utilization. | `src/engine/components/` |
| **Dependency graph** | Directed edges saying who calls whom, for which traffic (`all`, `read`, `write`) and what share. Must be acyclic. | `src/engine/components/graph.ts` |
| **Decision** | An action the engineer takes: prerequisites, immediate effects, ongoing effects, cost impact, complexity impact, side effects, resources required, and optionally the time it takes (`duration`) and what it reveals (`reveals`). | `src/engine/decisions/` |
| **Observation** | What the engineer can see: a metric, the workload mix, or one component's utilization, health, latency or errors. Some start hidden; investigation decisions reveal them without changing the system. | `src/engine/observations/` |
| **Effect** | A declarative state change (add a component, scale it, redirect traffic, change a constraint, …). Decisions and events are built from effects. | `src/engine/effects/` |
| **Event** | Something that happens to the engineer: a traffic spike, a failing database, a budget cut. Fires at a logical time or when a condition first holds. | `src/engine/events/` |
| **Constraint** | A limit: budget, complexity (what the team can operate), a metric bound, a requirement such as data residency, or a deadline. Can change mid-scenario. | `src/engine/constraints/` |
| **Consequence** | A deterministic description of something that changed, classified as positive/negative/neutral with a severity. | `src/engine/history/` |
| **Decision record** | Every applied decision: id, logical timestamp, the engineer's rationale (kept verbatim), what they could observe at the time, what it revealed, state before and after, consequences, side effects. | `src/types/decisions.ts` |
| **Objective** | What counts as doing well: a condition that must hold at the end (`final`), at every tick (`throughout`), or for a share of the time (`fractionOfTime` with a `threshold`). | `src/engine/scoring/objectives.ts` |
| **Result** | Outcome (`success`/`partial`/`failure`), score, peak and time-weighted metrics, cost, complexity, objectives, constraint violations, incident impact (successful, failed and throttled requests, business impact, SLO-violation minutes, when it stabilized), strengths and weaknesses. | `src/engine/scoring/` |
| **Postmortem** | Structured incident report built from a run: summary (outcome, time to stabilize), impact, every decision with its rationale, knowledge and cost, the constraint timeline, initial and final architecture, timeline, and measurable learning signals. | `src/engine/scoring/postmortem.ts` |

### Metrics

`requestsPerSecond`, `latency`, `p95Latency`, `p99Latency`, `errorRate`, `availability`, `throttleRate`, `serverErrorRate`, `cpuUtilization`, `memoryUtilization`, `databaseUtilization`, `cacheHitRate`, `queueDepth`, `monthlyCost`.

`errorRate` counts rate-limited requests as failures, because users see them; `throttleRate` and `serverErrorRate` split it.

Metrics that do not apply are absent (no cache, no `cacheHitRate`), and a scenario can track a subset with `metrics: [...]`. Utilization metrics are demand divided by capacity, so values above 1 mean overload.

### Cost and complexity

Each component instance has a `Cost` (`{ hourly, monthly }`, monthly = hourly × 730). The system's cost is the sum of its instances plus any `additionalCosts` (licences, support). The numbers are not real cloud prices, but they are consistent with each other.

Complexity is tracked separately as `complexityScore`. Adding a cache can lower latency and cost little, yet still raise complexity, and a `complexity` constraint models how much a team can operate.

## Simulation lifecycle

Time is **logical**, in minutes (`T+0`, `T+1 min`, …), never wall-clock. `advance(n)` runs `n / timeStep` ticks, so `advance(10)` is identical to ten `advance(1)` calls.

**Choosing a decision**

```
Current state
  → validate (valid / invalid / unavailable)
  → apply immediate effects, cost impact, complexity, resources
  → apply side effects whose condition holds
  → calculate metrics
  → generate consequences + decision record (with what was observable)
  → start ongoing effects, reveal observations
  → if the decision has a duration, advance that many minutes
```

**Each tick**

```
advance time (integrate accumulations such as queue backlog)
  → apply ongoing effects
  → process events
  → calculate metrics
  → check constraints and objectives, record a sample
```

After `advance()` the consequences of the whole period are reported with their causes (the events and ongoing effects involved).

### Decision validation

| Status | Meaning | Examples |
| --- | --- | --- |
| `valid` | Can be executed. Includes a preview of the projected state, cost delta and consequences. | |
| `invalid` | Does not apply to this situation. | unknown id, already taken, prerequisite not met, refers to a component that does not exist |
| `unavailable` | Possible in principle, but blocked by resources or constraints. | `"Monthly budget would be exceeded by $1,000."` |

A blocking constraint only blocks decisions that introduce or worsen a violation: when the budget has already been cut below current spend, scaling down remains available. Rejected decisions are never applied; the attempt is recorded in the history.

### The flow model

Metrics come from one small, readable model in `src/engine/metrics/flow.ts`:

1. **Forward pass** (callers before callees): read and write traffic flow from the clients through the graph. Each component throttles (rate limit), fails a fraction of what it accepts (health, plus overload once demand exceeds capacity) and forwards what it served. Caches forward only misses; queues forward what their consumers can take and build a backlog otherwise.
2. **Backward pass** (callees before callers): a request's latency and error rate at a component are its own plus those of the synchronous dependencies it calls, weighted by how often it calls them.

So when the database's capacity is exceeded or it becomes unhealthy, the application's latency and errors rise, and the clients see it. Latency grows with utilization through a queueing factor, and tail latency (p95/p99) with the busiest component on the request path. Queues break the chain: callers do not wait on, or fail with, the workers behind them.

Some requests cost more than others: a component's `readCost` and `writeCost` configuration weigh its demand per request class, and `baseErrorRate` sets a load-independent error floor.

It is intentionally not a perfect distributed-systems simulator. Each formula is a few lines, and new component types only need a catalog entry (`src/engine/components/catalog.ts`).

## Creating a scenario

Scenarios are declarative. Engine code contains no scenario-specific logic.

```ts
import { createScenario, defineScenario } from "@architecture-lab/engine";

const definition = defineScenario({
  id: "slow-reports",
  title: "Reports are slowing the checkout",
  workload: { requestsPerSecond: 400, readRatio: 0.9 },
  resources: { engineerDays: 5 },
  initialState: {
    components: [
      { id: "client", type: "client" },
      { id: "app", type: "application", instances: 3 },
      { id: "db", type: "database" },
    ],
    dependencies: [
      { from: "client", to: "app" },
      { from: "app", to: "db", traffic: "read" },
      { from: "app", to: "db", traffic: "write" },
    ],
  },
  constraints: [
    { id: "budget", kind: "budget", description: "Monthly budget", limit: 2000 },
    { id: "slo", kind: "metric", description: "p95 SLO", metric: "p95Latency", bound: "max", limit: 200 },
  ],
  decisions: [
    {
      id: "add-replica",
      title: "Add a read replica",
      description: "Send half of the reads to a replica.",
      immediateEffects: [
        { type: "addComponent", component: { id: "replica", type: "databaseReplica" } },
        { type: "redirect", target: "db", to: "replica", traffic: "read", fraction: 0.5 },
      ],
      complexityImpact: 2,
      requires: { engineerDays: 2 },
    },
  ],
  events: [
    {
      id: "month-end",
      title: "Month-end reporting",
      description: "Finance runs heavy reports.",
      trigger: { at: 10 },
      effects: [{ type: "workload", requestsPerSecond: { multiply: 2 } }],
    },
  ],
  objectives: [
    { id: "fast", description: "p95 under 200 ms", condition: { type: "metric", metric: "p95Latency", op: "<=", value: 200 } },
  ],
  completion: { maxDuration: 30 },
});

const scenario = createScenario(definition); // throws ScenarioValidationError listing every problem
```

`defineScenario` only gives type checking. `createScenario` validates (unknown metrics, dangling or cyclic dependencies, duplicate ids, bad durations, …), builds the initial state, calculates its metrics and freezes the result.

See `src/scenarios/10x-traffic-incident.ts` for a complete scenario with hidden information, investigations that take time, ongoing effects (a cache warming up, a database failover), conditional events, reversible decisions and a mid-scenario budget cut.

A scenario can also declare a `businessImpact` model (`{ valuePerFailedRequest, valuePerThrottledRequest }`) to price failed and throttled requests in the result.

## Determinism

The same **scenario + initial state + decision sequence** always produces the same result, byte for byte.

- No wall-clock time: time is a logical counter advanced by `advance()`.
- No randomness: every formula is deterministic. If randomness is ever needed, it will come from a seeded generator stored in the state.
- Fixed iteration order: components and dependencies are arrays, and graph traversal breaks ties by declaration order.
- Values are rounded at well-defined points, so floating-point noise does not leak into results.
- State is plain data. The engine never mutates a state it has handed out; getters return copies and scenarios are frozen.
- Every call is recorded as an action. `replay(scenario, simulation.getHistory().actions)` reproduces a run exactly.

The test suite checks all of this, including a guard that `src/` never uses `Math.random`, `Date.now` or `new Date()`.

## Project layout

```
src/
  types/            domain types (scenario, state, components, decisions, events, constraints, results, …)
  engine/
    simulation/     the orchestrator, logical time, ongoing effects
    scenario/       scenario definition and validation
    state/          cloning, lookup, numeric helpers
    components/     catalog, health, factory, dependency graph
    effects/        declarative state changes
    conditions/     declarative predicates
    decisions/      validation, preview, application
    events/         event triggering
    constraints/    checks, blocking rules, violation tracking
    metrics/        metric definitions and the flow model
    costs/          cost model
    history/        consequence generation
    observations/   what the engineer can see
    scoring/        objectives and the final result
  scenarios/        built-in scenarios
  index.ts          public API
tests/              Vitest unit and scenario tests (tests/support: playbooks, strategy search, reports)
docs/               analysis and reports
examples/           runnable examples
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm test` | Run the tests once |
| `npm run test:watch` | Run the tests in watch mode |
| `npm run typecheck` | Type-check source, tests and examples |
| `npm run build` | Compile `src/` to `dist/` with type declarations |
| `npm run example` | Play a playbook against the 10× Traffic Incident (`npm run example -- B` for another) |
| `npm run report:strategies` | Compare the five playbooks |
| `npm run report:landscape` | Search 14,336 plans (about three minutes) and print outcomes and the Pareto frontier |

## The 10× Traffic Incident

The built-in scenario: a product launch goes viral, traffic climbs from 10,000 to 100,000 rps, PostgreSQL is the hidden bottleneck, and finance cuts the budget halfway through. [`docs/10x-traffic-incident.md`](docs/10x-traffic-incident.md) describes the learning experience, the hidden information, the decisions and trade-offs, and the results: five playbooks (four succeed, for different reasons) and a search of 14,336 plans with 192 successes, 3,152 partial outcomes and no dominant plan. `tests/traffic-incident.test.ts` covers each mechanic.

## Stress test

[`docs/phase-1.5-stress-test.md`](docs/phase-1.5-stress-test.md) records the Phase 1.5 stress test of the engine on an earlier, smaller version of the scenario (300 → 3,000 rps), which has since been replaced. It covers trade-offs between strategies, decision timing, investigation, delayed consequences, constraints, determinism, counterfactual replay, and the known modeling weaknesses.
