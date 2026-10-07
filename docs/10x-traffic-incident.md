# The 10× Traffic Incident

The first polished scenario built on the engine. Source: [`src/scenarios/10x-traffic-incident.ts`](../src/scenarios/10x-traffic-incident.ts). Tests: [`tests/traffic-incident.test.ts`](../tests/traffic-incident.test.ts).

## The learning experience

A product API serves 10,000 rps. Everything looks fine: p99 is 178 ms, 0.1% of requests fail, application CPU is at a third. At T+3 a launch goes viral. Traffic reaches 50,000 rps by T+6 and 100,000 rps by T+13, holds through T+22, then settles at a new normal of 30,000 rps from T+29. The run lasts 45 logical minutes.

```
Users → API Gateway → Application Cluster (6 × 5,000 rps) → PostgreSQL (15,000 units/s)
```

The engineer sees errors and latency climb, has to work out why, and has to keep the service up without building something the team cannot run or finance will not pay for. Halfway through, finance cuts the budget. Spending that was the right call at the peak becomes the problem to solve once traffic settles.

The scenario is meant to feel like an incident, not a puzzle: things go wrong before anyone understands them, every fix has a price, and nothing announces the right answer.

## Hidden information

Only headline metrics are visible at first: request rate, p99 latency, error rate, throttled requests, application CPU, monthly cost, cache hit rate and queue depth (the last two once a cache or queue exists).

| Hidden fact | What it means | Revealed by |
| --- | --- | --- |
| Reads are 94% of surge traffic (80% before) | The surge is people browsing. Reads, not writes, are what grows. | Investigate the traffic |
| 90% of reads are cacheable | A cache can absorb most of the read load, eventually. | Investigate the traffic |
| PostgreSQL is already at ~70% CPU and saturates at ~15,000 rps of today's mix | The database, not the application, is the first thing to break. At T+3 it is past 100% while application CPU is at 50%. | Investigate the database |
| PostgreSQL query latency | How bad it is. | Investigate the database |
| A write costs 1.25× a read | Even with every read cached, writes keep PostgreSQL busy at 100,000 rps. | Investigate the database |

Each investigation takes two logical minutes. The incident keeps running meanwhile, and investigating changes nothing about the system (a test checks that the state after investigating equals the state after waiting two minutes). Every decision record keeps the engineer's rationale, exactly what was observable when they decided, what the decision revealed, and the full state before and after.

## Changing constraints

| Constraint | Limit | Enforcement |
| --- | --- | --- |
| Monthly run-rate (finance) | $3,500, cut to **$2,800 at T+25** | Recorded, not blocking: overspending during the incident is tolerated, but a run that ends over budget cannot succeed. |
| What the on-call team can operate | Complexity 10 (starts at 3) | Blocking |
| p99 latency SLO | 500 ms | Recorded |
| Availability SLO | 99%, rate-limited requests count as unavailable | Recorded |

The budget cut is explained in the scenario as the platform team moving to a shared cost allocation model. It lands while traffic is still falling. A read replica, an upgraded PostgreSQL instance or a large application fleet are good decisions at T+10 and liabilities at T+25. Each can be reversed (remove the replica, downgrade the database, scale down), but downgrading means another failover, and scaling down is refused while application CPU is at 60% or more.

## Decisions

| Decision | Effect | Price |
| --- | --- | --- |
| Investigate the traffic / the database | Reveals hidden facts | 2 minutes each |
| Scale the application (repeatable) | +4 instances (+20,000 rps) | +$292/month; does nothing for PostgreSQL, and once the app stops failing requests early it sends *more* load to the database |
| Scale the application down (repeatable) | −4 instances | Refused while CPU ≥ 60% |
| Add a Redis cache | Reads go to Redis first; misses go to PostgreSQL | +$255.50/month, complexity +3, stale reads. Starts at a 20% hit rate and warms by 14 points a minute to the cacheable share (90%). |
| Add / remove a read replica | Half of the reads that reach PostgreSQL go to a replica, immediately | +$876/month, complexity +2, replica lag. Writes still all go to the primary. |
| Upgrade / downgrade PostgreSQL | Twice / half the capacity at twice / half the price | Degraded (60% capacity, 1% errors) for a three-minute failover first |
| Enable rate limiting | The gateway rejects traffic above 40,000 rps with HTTP 429 | Complexity +1; throttled users and business impact |
| Tighten / relax the rate limit (repeatable) | ±10,000 rps, never below 10,000 | — |
| Queue writes asynchronously | Writes go through a queue drained by workers at up to 4,000 writes/s | +$292/month, complexity +4, eventual consistency; the backlog has to drain afterwards |

The rate limit is adjusted in fixed 10,000 rps steps with ordinary repeatable decisions. There is no parameter system.

### Delayed consequences

All of these use existing engine features: ongoing effects, events with conditions, decision duration and queue backlog.

- **Cache warm-up**: Redis needs about five minutes to reach its hit rate. Enabling it at T+3 or at T+7 is a large difference.
- **Failover**: an upgraded PostgreSQL only has its new capacity three minutes later, and is *worse* until then. Upgrading at the height of the surge hurts before it helps.
- **Cache eviction storm** at T+18 (only if Redis exists): a deploy restarts half the Redis nodes, the hit rate halves, and PostgreSQL takes the misses at 100,000 rps. Plans that rely on the cache alone collapse for two or three minutes; plans with database headroom or a rate limit ride it out.
- **Queue backlog**: asynchronous writes absorb the peak and drain afterwards at the workers' pace.
- **Budget pressure**: capacity bought for the peak is still running when the budget is cut.

## Scoring

The whole incident is scored, not just the final state.

| Objective | Kind |
| --- | --- |
| At least 95% of requests succeed (throttled count as failures) for 70% of the incident (weight 2) | share of time |
| Server errors at or below 2% for 80% of the incident | share of time |
| p99 at or below 500 ms for 70% of the incident | share of time |
| At the end: p99 ≤ 300 ms and error rate ≤ 1% | final |
| At the end: PostgreSQL CPU ≤ 80% | final |

Outcome is `success` when every objective is met and no constraint is still violated at the end, `partial` when at least half the objective weight is met. Separately, every run reports:

- requests: total, successful, **failed** (server errors) and **throttled** (rate limited), counted per minute;
- **business impact**: $0.002 per failed request, $0.001 per throttled one (some throttled users retry later);
- SLO-violation minutes and violation minutes per constraint;
- when the incident started, when it stabilized, and the time in between;
- final monthly run-rate, spend during the incident, complexity, and constraint violations.

`simulation.getPostmortem()` packages all of it as structured data: incident summary, impact, every decision (timestamp, rationale, information available, state before and after, cost and complexity impact), rejected attempts, events, the constraint timeline and violations, the initial and final architecture, the minute-by-minute timeline, and **learning signals**: measurable facts with a strength/weakness/neutral assessment, such as `time-to-first-response`, `investigated-before-acting`, `decisions-with-hidden-information`, `slo-violation-share`, `throttled-share`, `within-budget-at-end`, `idle-capacity-at-end`, `queue-backlog-at-end`, `complexity-added` and `rationale-coverage`. They are templated text over numbers, not generated explanations.

## Trade-offs, and why several strategies can succeed

The scenario has one physical fact at its centre: 10× read traffic cannot be served by any PostgreSQL topology the budget allows. Reads have to come off the database. But that is where the agreement ends:

- **How fast**: acting at T+3 on a guess saves four minutes of collapse; investigating first means acting on evidence. Both can succeed.
- **What else**: at 100,000 rps even a warm cache leaves PostgreSQL near its limit, and the eviction storm takes the cache away for a few minutes. Headroom can come from a replica (instant, expensive), an upgrade (bigger, failover first, most expensive), a rate limit (free, costs users), or asynchronous writes (no throttling, most complex, a backlog afterwards). Each pairs differently with the complexity limit and the budget cut.
- **Who pays**: protecting the system with a rate limit fails the fewest requests and throttles the most; serving everyone throttles nobody and fails more during the bad minutes.
- **Clean-up**: every plan that succeeds gives back what it bought for the peak before the end.

Different plans come out ahead on different measures, and none is ahead on all of them (see the results below).

## Results

### The five playbooks

`npm run report:strategies` plays the playbooks in [`tests/support/strategies.ts`](../tests/support/strategies.ts). Each reacts to what it can see at the time and records a rationale for every step.

| Strategy | Outcome | Score | Availability | Failed | Throttled | SLO-violation min | Peak p99 | Time to stabilize | Final cost/month | Incident spend | Complexity | Business impact |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A. Scale first | partial | 68 | 82.5% | 28.1M | 0 | 14 | 5,252 ms | 18 min | $2,701 | $3.84 | 6 | $56,176 |
| B. Investigate first | success | 80 | 88.9% | 15.9M | 0 | 10 | 4,128 ms | 18 min | $2,409 | $3.53 | 6 | $31,835 |
| C. Cache first | success | 83 | 96.8% | 6.3M | 0 | 8 | 1,826 ms | 18 min | $2,409 | $3.41 | 6 | $12,563 |
| D. Protect the system | success | 81 | 94.3% | 5.7M | 4.8M | 15 | 2,234 ms | 19 min | $2,409 | $3.35 | 7 | $16,283 |
| E. Balanced | success | 79 | 95.0% | 6.1M | 3.6M | 9 | 2,331 ms | 19 min | $2,701 | $3.91 | 7 | $15,750 |

- **A** scales the application and upgrades PostgreSQL in the middle of the surge, investigates at T+8 when that has not worked, and adds Redis at T+10. It recovers, but fails its server-error objective (71% of the time against 80%).
- **B** investigates for four minutes, then adds Redis, upgrades PostgreSQL and scales. It succeeds, with the most failed requests of the four successes: 9.6M more than C.
- **C** bets on caching at T+3 and adds a replica at T+13 when errors persist. Fewest SLO-violation minutes, highest availability, no throttling.
- **D** caps traffic at 40,000 rps first and relaxes the cap as Redis warms. Fewest failed requests and lowest incident spend, but 4.8M throttled requests and the most SLO-violation minutes.
- **E** starts Redis and scaling at once, upgrades PostgreSQL, and uses a rate limit only as a circuit breaker during the eviction storm. It sits between C and D.

C is at least as good as B on every measure in this table: when the hypothesis is right, acting on it beats confirming it. Among the playbooks no single one is best at everything (D fails fewest, C throttles none and violates SLOs least, D spends least during the incident).

### Strategy search

`npm run report:landscape` (about three minutes) plays every combination of:

- investigation before acting: none, traffic, database, both;
- any subset of cache, replica, upgrade, asynchronous writes and rate limiting, applied when acting;
- for a rate limit: start at 40K or 20K, and never relax / relax 10K a minute from T+8 / lift it after the peak;
- 0–3 scale-outs when acting and 0–3 more as the second wave arrives;
- with or without clean-up after T+30 (remove replica, downgrade, scale down until refused).

| | |
| --- | --- |
| Plans explored | **14,336** (10,956 distinct once refused steps are collapsed, e.g. a mitigation blocked by the complexity limit) |
| Success | **192** |
| Partial | **3,152** |
| Failure | **7,612** |
| Pareto frontier (failed, throttled, SLO-violation minutes, peak p99, final cost, incident spend, complexity, time to stabilize, business impact) | **614** plans, 38 of them successful |
| Pareto frontier among successful plans only | 39 plans |
| Plans dominating every other plan | **0** |

Phase 1.5's scenario had 1 success in 292 plans.

Best plan per measure among plans that did not fail:

| Measure | Best plan | Outcome |
| --- | --- | --- |
| Failed requests | cache + rate limit at 20K, never relaxed | partial (94.6M throttled) |
| Throttled requests | cache + replica, scale 1+3, clean-up | success |
| SLO-violation minutes | cache + replica, scale 2+3, clean-up | success (4 minutes) |
| Time to stabilize | cache + replica + upgrade, scale 2+3, clean-up | success (17 minutes) |
| Business impact | cache + replica + upgrade, no clean-up | partial (over budget at the end) |
| Final cost | cache + rate limit at 20K, never relaxed, no scale-out | partial |
| Complexity | upgrade + rate limit at 20K, never relaxed | partial |

Successful plans by mitigation set: cache + upgrade + async 48, cache + replica + rate limit 24, cache + upgrade + rate limit 24, cache + replica + upgrade (± rate limit) 48, cache + upgrade 24, cache + replica 18, cache + async 6. 138 of the 192 investigated first; all 192 cleaned up after the peak.

### Counterintuitive outcomes

1. **The cache is necessary but never enough.** Every successful plan includes Redis, yet Redis alone never succeeds (0 of 116 plans, 48 partial). Writes keep PostgreSQL near its limit at 100,000 rps, and the eviction storm at T+18 sends the misses straight back to it. What makes a plan succeed is what it pairs with the cache.
2. **The plan that fails the fewest requests turns away two thirds of the users.** Cache plus a 20K rate limit that is never relaxed fails only 0.1M requests, fewer than any success, and throttles 94.6M. Its business impact ($94,699) is about 22 times the best successful plan's ($4,315).
3. **Scaling first makes the incident worse before anything makes it better.** Strategy A's peak p99 (5.3 s) is the worst of the five playbooks. Once the application stops failing requests early, all of them reach PostgreSQL, and upgrading PostgreSQL mid-surge takes away 40% of its capacity for the three-minute failover exactly when it is needed.

Also worth knowing: the zero-throttle asynchronous-write plans succeed while still holding about 1.3M unapplied writes at T+45, which take roughly another 20 minutes to drain. The objectives do not measure data freshness; the postmortem flags it as the `queue-backlog-at-end` weakness. Adding a "writes caught up" objective would be a one-line scenario change if that should count against success.

## Engine changes this scenario needed

Small, scenario-neutral additions. Nothing scenario-specific lives in engine code.

- **Request cost**: `readCost` / `writeCost` configuration weighs a component's demand per request class ("some requests are more expensive"), and `baseErrorRate` adds a load-independent error floor (the initial 0.1%).
- **Metrics** `throttleRate` and `serverErrorRate`: error rate split into rate-limited requests and server errors, so objectives can tell them apart.
- **Observation signals** for a component's configuration value and for a flag, so hidden facts such as cacheability and write cost can be revealed.
- **Decision records** carry `costImpact` and `complexityImpact`.
- **Incident accounting**: total, successful, failed (excluding throttled) and throttled requests; SLO-violation minutes and violation minutes per constraint; an optional per-scenario `businessImpact` model.
- **Constraint history**: when a constraint is added, updated or removed, it is logged in the history.
- **Postmortem**: `createPostmortem()` and `Simulation.getPostmortem()`.

## Limitations

None of these blocks the scenario; they are where it simplifies.

- **Knowledge does not gate anything.** Hidden information changes what a person knows, not what the engine allows, so a brute-force search plays as if it knew everything. In hindsight investigation can only cost time. Its value shows up in human play, where a wrong guess (scaling, a replica alone) is what gets punished.
- **No retries or backpressure.** Throttled and failed users do not come back and add load, so there is no retry storm.
- **Rate limiting is uniform.** It cannot prefer writes, logged-in users or cheap endpoints.
- **Throughput only.** There is no memory, connection-pool or replication-lag model; staleness is a flag.
- **Search cost.** About 11 ms per 45-minute run; the full search takes about three minutes on one core.
