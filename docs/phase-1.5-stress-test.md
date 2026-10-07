# Phase 1.5: engine stress test

**Question:** can the engine produce meaningfully different outcomes from different, reasonable engineering strategies, with genuine trade-offs rather than "A is right, B is wrong"?

**Answer:** yes, after the fixes in this PR. Before them, it could not.

| Check | Verdict |
| --- | --- |
| Engine health | **PASS** (with the fixes in this PR) |
| Determinism | **PASS** |
| Counterfactual capability | **PASS** |
| Dominant strategy | **None.** No strategy is better on every dimension, and 0 of 292 explored plans dominate all others. |

Everything below is reproducible:

```bash
npm test                    # includes tests/stress.test.ts, which asserts every finding below
npm run report:strategies   # regenerates the strategy table
npm run report:landscape    # brute-forces the decision space and prints the Pareto front
```

## 1. What the first pass found

The five strategies were first run against the engine and scenario exactly as merged in Phase 1. Results:

- **The outcome ignored the incident.** It was decided by the final state alone. "Cache first" scored *success* with 79% availability and 30 straight minutes of SLO violation.
- **Every strategy had the same peak.** The 10× spike landed in a single tick, before anyone could react, so peak latency and peak errors were identical for every strategy.
- **There was no way to investigate.** There were no investigation decisions and no notion of what the engineer knows, so "Investigate first" could not be expressed. Decision records could not say what information was available when the decision was taken.
- **Decisions took no time.** Investigating, or anything else, cost nothing.
- **Rate limiting was never worth it.** Overload failed only the excess requests, which is the same thing shedding does, so "Protect the system" could only lose.
- **Queues grew forever and never rejected anything.** Asynchronous processing had no downside.
- **The scenario could not be won.** Across 130 brute-forced plans there were 0 successes, for two reasons:
  - The scale-down prerequisite blocked clean-up after the budget cut.
  - The $3,000 budget made it impossible to serve 3,000 rps within the latency SLO at all.

Those findings drove the changes listed under [Must fix before Phase 2](#must-fix-before-phase-2). Every result below uses the fixed engine.

## 2. Strategy comparison

Five strategies were played against "The 10× Traffic Incident" (`tests/support/strategies.ts`). Each has the brief's shape, plus clean-up once traffic settles. Every decision carries a rationale.

| Strategy | Outcome | Score | Peak p95 | Peak errors | Availability | Final cost/month | Spend (45 min) | Complexity | Decisions | Stabilized | Failed requests | of which throttled | Minutes in violation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A. Scale first | failure | 13 | 975 ms | 55.5% | 66.9% | $2,868.90 | $3.09 | 3 | 6 (+1 rejected) | never | 2.61M | 0.00M | 43 |
| B. Investigate first | partial | 60 | 3042 ms | 100.0% | 90.1% | $2,905.40 | $2.97 | 8 | 9 | T+35 | 0.67M | 0.00M | 43 |
| C. Cache first | success | 84 | 3032 ms | 100.0% | 85.8% | $2,321.40 | $2.72 | 6 | 10 | T+24 | 1.02M | 0.00M | 24 |
| D. Protect the system | failure | 13 | 2501 ms | 100.0% | 68.0% | $3,087.90 | $3.01 | 4 | 9 | never | 2.46M | 0.62M | 43 |
| E. Balanced | partial | 48 | 2952 ms | 100.0% | 81.2% | $3,051.40 | $3.10 | 7 | 10 | T+35 | 1.39M | 1.17M | 43 |

Objectives (achieved fraction):

- A: users-served ✗ (28.9%), responsive ✗ (4.4%), latency ✗ (0.0%), errors ✓ (100.0%), database-headroom ✗ (0.0%)
- B: users-served ✓ (80.0%), responsive ✗ (28.9%), latency ✓ (100.0%), errors ✓ (100.0%), database-headroom ✓ (100.0%)
- C: users-served ✓ (75.6%), responsive ✓ (73.3%), latency ✓ (100.0%), errors ✓ (100.0%), database-headroom ✓ (100.0%)
- D: users-served ✗ (28.9%), responsive ✗ (4.4%), latency ✗ (0.0%), errors ✓ (100.0%), database-headroom ✗ (0.0%)
- E: users-served ✗ (28.9%), responsive ✓ (93.3%), latency ✓ (100.0%), errors ✓ (100.0%), database-headroom ✓ (100.0%)

How to read it:

- **Score** is 70 × weighted objectives met + 30 × the fraction of time with no constraint violated.
- **Spend** is what the 45 simulated minutes cost.
- **Stabilized** is the time from which every SLO held until the end.
- **Failed requests** is the business impact: users who got an error, including those turned away by rate limiting.

## 3. Trade-off landscape

There is no dominant strategy. Each one wins somewhere and pays somewhere else:

| Strategy | Wins on | Pays with |
| --- | --- | --- |
| **A. Scale first** | Fastest reaction (lowest peak errors, 55% instead of 100%) and the simplest architecture (complexity 3). | Never addresses the database, which takes every read. It never stabilizes, the budget blocks the next scale-out, and it ends over the reduced budget. |
| **B. Investigate first** | Fewest failed requests (0.67M) and the best availability (90%). The replica and cache together leave the most database headroom. | A total outage (100% errors) during the four minutes spent investigating, the highest complexity (8), and it ends over budget. It misses the "responsive" objective. |
| **C. Cache first** | The only success. Cheapest run-rate afterwards ($2,321) and stable earliest (T+24). | 1.5× B's failed requests, because it scaled later, and it was over budget from T+25 to T+36 until it trimmed capacity. |
| **D. Protect the system** | Lowest peak p95 of the late reactors. Rejected users are fast 429s rather than slow failures. | Without a cache the database stays saturated behind the limit. It never stabilizes, rejects 0.62M requests, and ends over budget. |
| **E. Balanced** | Best latency compliance (p95 within SLO 93% of the time). | Keeps latency low by rejecting 1.17M users, so the availability SLO is violated for 30 minutes. It ends over budget because of the database upgrade. |

The brute-force search (`npm run report:landscape`) backs this up. It tries every combination of the five mitigations, 0–5 scale-outs, reacting at T+3 or T+6, optionally relaxing the rate limit, and trimming afterwards:

Distinct plans: 292 (success 1, partial 49, failure 242)
Pareto front (failed requests, minutes in violation, peak p95, monthly cost, complexity): 31 plans
Plans dominating every other plan: 0

| Plan | Outcome | Score | Failed requests | Minutes in violation | Peak p95 | Cost/month | Complexity |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T+3 scale×4 enable-cache relax×0 trim×4 | success | 85 | 0.36M | 22 | 744 ms | $2321 | 6 |
| T+3 scale×3 enable-cache+increase-database-capacity relax×0 trim×2 | partial | 61 | 0.01M | 41 | 681 ms | $3051 | 6 |
| T+3 scale×3 enable-cache+add-database-replica relax×0 trim×2 | partial | 61 | 0.06M | 41 | 681 ms | $2905 | 8 |
| T+3 scale×2 enable-cache+enable-rate-limiting relax×0 trim×0 | partial | 55 | 1.83M | 32 | 681 ms | $2321 | 7 |
| T+3 scale×3 enable-cache+enable-rate-limiting relax×0 trim×2 | partial | 55 | 1.83M | 32 | 681 ms | $2321 | 7 |
| T+3 scale×4 enable-cache+enable-async-processing relax×0 trim×4 | partial | 39 | 0.63M | 39 | 681 ms | $2606 | 10 |
| T+3 scale×2 add-database-replica+increase-database-capacity relax×0 trim×0 | partial | 37 | 1.44M | 42 | 839 ms | $3453 | 5 |
| T+3 scale×2 enable-rate-limiting+increase-database-capacity relax×0 trim×0 | failure | 14 | 1.77M | 42 | 681 ms | $2869 | 4 |
| T+3 scale×3 enable-rate-limiting+increase-database-capacity relax×0 trim×2 | failure | 14 | 1.77M | 42 | 681 ms | $2869 | 4 |
| T+3 scale×2 increase-database-capacity relax×0 trim×0 | failure | 14 | 1.87M | 42 | 1085 ms | $2869 | 3 |
| T+3 scale×3 increase-database-capacity relax×0 trim×2 | failure | 14 | 2.56M | 42 | 975 ms | $2869 | 3 |
| T+3 scale×1 enable-rate-limiting+increase-database-capacity relax×0 trim×0 | failure | 13 | 3.12M | 43 | 824 ms | $2431 | 4 |
| T+3 scale×1 enable-cache+enable-rate-limiting relax×0 trim×0 | failure | 13 | 3.13M | 43 | 940 ms | $1883 | 7 |
| T+3 scale×1 increase-database-capacity relax×0 trim×0 | failure | 13 | 4.24M | 43 | 1699 ms | $2431 | 3 |
| T+3 scale×1 enable-cache relax×0 trim×0 | failure | 13 | 4.24M | 43 | 1693 ms | $1883 | 6 |

The front contains clearly different shapes:
- **Cheapest success:** cache plus aggressive scaling, then trimming.
- **Fewest failures:** cache plus database capacity or a replica. It costs more and can't get back under the reduced budget.
- **Lowest latency:** rate limiting. It turns users away.
- **Simplest:** database capacity only. It is cheap in complexity and poor everywhere else.

**Caveat:** only 1 of 292 explored plans reaches *success*. That is a scenario-tuning question, not an engine one (see [Recommended later improvements](#recommended-later-improvements)).

## 4. Decision timing

The same plan (a cache plus four scale-outs), with only the cache's timing changed:

| Cache enabled | Failed requests | Availability |
| --- | --- | --- |
| T+2, before the spike (warm when traffic arrives) | 0.64M | 90.6% |
| T+6, at the peak | 0.89M | 87.5% |
| T+8, after scaling | 1.25M | 83.0% |

Timing matters for two reasons:
- Traffic now ramps up from T+3 to T+6 instead of jumping in one tick.
- The cache warms over several minutes (an ongoing effect).

**One subtlety:** timing makes no visible difference while an upstream component fails 100% of requests. A cache added in front of the database changes nothing measurable while the application is collapsed in front of it. That is correct behaviour, but a UI will need to explain it.

## 5. Investigation

`investigate-traffic` and `investigate-database` have no effects on the system. They take 2 logical minutes each and reveal hidden observations:
- **Before investigating**, the engineer sees request rate, latency, p95, errors, application CPU, cost, cache hit rate and queue depth.
- **After investigating**, they also see "Traffic mix: reads are 80% of traffic, writes 20%", database utilization and database latency.

A test asserts that the state after investigating is identical to the state after simply waiting 2 minutes. The only difference is what the engineer can see. The price of investigating is real: strategy B suffers a full outage while it investigates.

## 6. Delayed consequences

The engine can represent decisions that look good now and hurt later, using ongoing effects, accumulating state and events:

- **Asynchronous writes:** errors drop to 0% within five minutes. The queue then fills at 18,000 messages a minute because the workers can't keep up, and once it hits its 100,000-message limit 10% of requests fail (all writes beyond worker capacity).
- **Aggressive scaling:** it is affordable at first. When finance cuts the budget at T+25, strategies A, B, D and E are left over budget. C only gets back within budget by trimming at T+36.
- **Scaling the application while traffic ramps:** this pushes the bottleneck onto the database as load arrives.

What it can't yet represent cleanly is a delay before a decision's effects land, such as a replica taking 10 minutes to provision. A decision's `duration` passes time *after* its effects apply. See later improvements.

## 7. Constraints

- **Budget:** a decision that would exceed it becomes `unavailable` with a reason ("Monthly budget would be exceeded by $390.90."), and is recorded as a rejected attempt. Strategy A runs into this.
- **Latency SLO:** "p95 at or below 250 ms for 60% of the scenario" is a `fractionOfTime` objective. B fails it, so B is *partial*, not *success*.
- **Availability:** a strategy that protects the system by rejecting users is not successful. Rejected requests count as failures, and "error rate at or below 5% for 75% of the scenario" is an objective. E and D both fail it, and so does the rate-limit-plus-cache plan tested in `tests/stress.test.ts`.

## 8. Determinism

Each strategy was replayed three times. Full histories (every state, event, sample, decision and consequence) and results are byte-identical. **PASS.** No source of nondeterminism was found. The guard test that bans `Math.random`, `Date.now` and `new Date()` in `src/` still passes.

## 9. Counterfactuals

Strategy A was replayed with exactly one decision changed: `increase-database-capacity` was replaced by `enable-cache`. Both runs complete with the same duration and comparable results:
- The counterfactual fails fewer requests.
- It costs less per month.
- It adds complexity.

This is a meaningful "what if". **PASS.** `replay(scenario, actions)` plus action editing is enough. No new API is needed for Phase 2.

## 10. Decision rationale

Every `DecisionRecord` now holds:
- `decisionId`, `title` and `timestamp` (logical time).
- `rationale`, verbatim.
- `knowledge`: the observations visible when the decision was taken, with their values and text. This is new.
- `revealed`: what an investigation uncovered. This is new.
- `stateBefore` and `stateAfter`: full system states.
- `consequences` and `sideEffects`.

Together with the samples and consequences in the history, that is enough to reconstruct what the engineer knew, why they acted, and what actually happened. Tests check this for every decision in strategy B. For example, its cache decision records that the 80% read share and database utilization were known at the time.

## Major modeling issues

The list starts with what this PR fixes and ends with what remains:

1. The outcome ignored how the incident went (fixed).
2. There was no information model, so investigation and knowledge at decision time were impossible (fixed).
3. Decisions took no time (fixed).
4. Overload was graceful, so rate limiting had no upside (fixed).
5. Queues were unbounded, so asynchronous processing had no downside (fixed).
6. Business impact and time to stabilization were not measured (fixed).
7. Effects are instantaneous. New replicas, database upgrades and caches are available immediately; only cache warm-up is modelled.
8. Decisions have no parameters. "Enable rate limiting" always means 2,000 rps, and scale-outs come in fixed steps of 4.
9. Horizontal scaling has no diminishing returns. Only the budget stops it.
10. Overloaded components never change health. There are no cascading failures, retry storms, timeouts or circuit breakers beyond the overload collapse factor.
11. A cache's hit rate is a configured number, not derived from a working set or memory size.
12. Rejected (429) and failed (5xx) requests weigh the same in availability. There is no revenue or user-trust model.
13. Over a 45-minute incident, spend is cents (about $3 for every strategy), so the cost trade-off rests entirely on the monthly run-rate and the budget constraint.
14. Tail latency is a formula of mean latency and the busiest component, not a distribution.
15. Peak metrics include the tick before anyone could react. Four of the five strategies peak at 100% errors, so "peak" discriminates poorly. Failed requests and minutes in violation are better comparators.

## Must fix before Phase 2

All of these are done in this PR:

- **Score the whole incident, not just the end.** Objectives can now be `fractionOfTime` with a `threshold`. Results carry `impact`: failed requests, throttled requests, minutes in violation, compliance and `stabilizedAt`. The score blends objectives (70) with compliance (30).
- **Information model.** Scenarios declare `observations` (metrics, workload or component signals), some hidden. Decisions can `reveal` them. `simulation.getObservations()` shows what is visible, and each `DecisionRecord` stores `knowledge` and `revealed`.
- **Decisions take time.** A decision's `duration` advances logical time after it is applied, and events keep firing meanwhile. Replay reproduces it from the single decide action.
- **Overload collapse.** `OVERLOAD_COLLAPSE` was raised from 0.05 to 0.3: an overloaded component fails more than its excess, so shedding load early has real value.
- **Bounded queues.** A `maxDepth` setting makes a full queue reject what its consumers can't drain.
- **Scenario tuning** (the scenario only, with no engine logic):
  - Traffic ramps up from T+3 to T+6.
  - The budget is $3,500, cut to $2,800 at T+25.
  - The rate limit starts at 2,000 rps and can be relaxed in 500 rps steps.
  - Scale-down is allowed below 75% utilization.
  - The queue holds at most 100,000 messages.
  - Two investigation decisions are added.
  - The read mix and database signals start hidden.
  - Two objectives judge the whole incident.

## Recommended later improvements

- **Lead times:** let a decision's effects land after a delay, so a replica takes 10 minutes to provision. This could be an effect-level `delay`, reusing the ongoing-effects machinery.
- **Parameterized decisions:** a rate-limit value or an instance count, so the decision space isn't a set of fixed steps.
- **Diminishing returns on horizontal scaling:** for example, database connection overhead per application instance.
- **Overload-driven health changes:** components that stay overloaded become degraded, which gives cascading failure.
- **Separate business impact:** distinguish rejected (429) from failed requests, optionally with a revenue-per-request figure.
- **Scenario tuning for learning:** more than one plan in 292 should reach *success*, so that several distinct, defensible playbooks win.
- **Better comparison metrics:** "peak after first response" or "failed requests in the first N minutes", so early-reaction quality can be compared without the unavoidable first tick.

## Not necessary

- Real cloud pricing, per-request latency distributions, stochastic failures, multi-region networking.
- Autoscaling as an engine feature. It can be modelled with events and ongoing effects when a scenario needs it.
- A general distributed-systems simulator. The flow model stays a few readable formulas, which is the point.
