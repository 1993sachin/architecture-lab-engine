# The Queue That Won't Drain

The second built-in scenario. Where the 10× Traffic Incident teaches *traffic overload → bottleneck → protect, scale or cache*, this one teaches *work accumulation → processing capacity → backlog → retries → freshness*. The API stays fast and available the whole time; the incident happens behind it.

## The system

```
Producers → Jobs API → Job Queue → Workers → PostgreSQL
```

- **Jobs API** (`apiGateway`): accepts a job and puts it on the queue. Fast (p99 ≈ 40 ms) and available unless the queue fills up or you rate-limit it.
- **Job Queue** (`queue`): room for 4,000,000 jobs. A failed job is delivered again, up to six times (`maxAttempts: 6`).
- **Workers** (`worker`): 12 instances × 580 jobs/s = 6,960 jobs/s. 1% of deliveries fail on their own (bad payloads, timeouts to other services).
- **PostgreSQL** (`database`): every job ends with a write. 7,600 writes/s of capacity.

Baseline: 5,000 jobs/s, workers at 72%, PostgreSQL at 65%, almost nothing waiting.

## How it unfolds

| When | What happens |
| --- | --- |
| T+3 | A customer starts a large import. The job rate grows about 6% a minute for nine minutes, to ~8,450 jobs/s. |
| ~T+10 | Jobs arrive faster than the workers can process them. The queue starts growing. |
| ~T+15 | Processing delay passes 60 seconds: the freshness SLO is breached and the operator is paged. API latency and availability are still fine. |
| T+16 | Month-end reporting starts on PostgreSQL and takes 10% of it. With the workers saturated, PostgreSQL is now just past capacity and starts failing writes; failed jobs come back as retries. |
| T+30 | The import eases off, about 3% a minute for twelve minutes. |
| T+40 | Reporting finishes; PostgreSQL has its full capacity again. |
| T+50 | The incident window closes. |

If nothing is done, the backlog peaks at about 2.2 million jobs and a new job waits more than five minutes before a worker picks it up. The run fails.

## What is hidden

Visible from the start: incoming jobs, queue depth, processing rate, processing delay, API p99 latency, API error rate, rejections, monthly cost.

Hidden until investigated (each investigation takes two minutes while the incident continues):

- **Investigate the workers**: worker utilization and the fleet's processing capacity.
- **Investigate failing jobs**: the share of deliveries that are retries, the share of jobs given up on, and how many deliveries a job gets.
- **Investigate the database**: PostgreSQL CPU and write latency.

A useful clue is visible without investigating: once retries start, the processing rate can be above the incoming rate while the queue still grows. The extra work is coming from somewhere.

## Decisions

| Decision | Effect | Trade-off |
| --- | --- | --- |
| Scale the workers | +6 instances (+3,480 jobs/s). Repeatable. | +$1,095/month each. Every extra delivery is also a write: in front of a saturated PostgreSQL it causes failures and retries that eat the new capacity. |
| Scale the workers down | −6 instances, never below 12. Only when fewer than 50,000 jobs are waiting. | Less headroom. |
| Increase the worker batch size | Worker capacity ×1.4. | One bad job fails its whole batch (+8 points of failures, retried), longer batches, more memory, +1 complexity. |
| Limit retries | Deliver a failed job at most twice, then dead-letter it. | Less repeated work, more jobs given up on when failures are high. |
| Pause low-priority work | Stop re-indexing and digest producers (−20% of jobs). | They must be running again by T+38 (a deadline constraint). |
| Resume low-priority work | Start them again. | The job rate goes back up by a quarter. |
| Rate-limit incoming jobs | Accept at most 7,000 jobs/s; reject the rest with 429. | Rejected jobs count against API availability and the business-impact model. |
| Remove the rate limit | Accept every job again. | |
| Upgrade the PostgreSQL instance | Twice the capacity at twice the price, after a three-minute failover during which it is degraded. | +$1,168/month; things get worse during the failover. |

## Objectives and constraints

- **SLOs** (monitored): processing delay at most 60 s; API availability at least 99% (rejections count).
- **Budget**: $5,000/month (monitored; overspending is recorded).
- **Complexity**: at most 8.
- **Deadline**: low-priority work running again by T+38.
- **Objectives**: jobs start processing within 60 s for 60% of the run (weight 2); at most 2% of jobs given up on for 80% of the run; the API accepts at least 99% of jobs for 70% of the run; fewer than 100,000 jobs waiting at the end.

## Playbooks

`src/scenarios/queue-wont-drain-playbooks.ts`. "Jobs given up" is estimated from the per-minute samples.

| Playbook | Outcome | Score | SLO-violation min | Freshness held | Jobs given up | Final cost/month | Complexity | Business impact |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A. Scale the workers and the database | success | 84 | 18 | 64% | 209k | $4,854.50 | 4 | $0 |
| B. Shed load and stop the retry storm | success | 89 | 19 | 62% | 4k | $3,686.50 | 4 | $0 |
| C. Bigger database, bigger batches | success | 93 | 11 | 78% | 75k | $4,854.50 | 5 | $0 |
| D. Throttle intake while the database is upgraded | success | 93 | 12 | 84% | 75k | $4,854.50 | 5 | $4,168.50 |
| E. Just add workers | failure | 31 | 13 | 55% | 759k | $5,876.50 | 4 | $2,857.08 |

Four playbooks succeed, each paying differently: B is cheapest and gives up almost no jobs but recovers slowest; C and D recover fastest but keep the larger database and add complexity, and D's rejections cost the business; A scales both tiers and pays for it until the extra workers are removed. E is the trap: the first scale-out sends PostgreSQL to about 150% and the second to about 200%; three quarters of what the workers process is retries, more than a quarter of jobs are given up on, and the queue fills until the API starts rejecting jobs.

## Plan search

`npm run report:queue-landscape` plays 384 plans: one or three investigations when paged at T+15, then every combination of six mitigations (with a second scale-out and a clean-up of extra workers as variants, and the follow-ups each implies: resuming paused work before the deadline, lifting a rate limit at T+30).

- 302 distinct runs: **96 success, 135 partial, 71 failure**.
- **No successful plan dominates** every other successful plan on cost, incident spend, complexity, SLO-violation minutes, average delay, jobs given up and business impact. The Pareto frontier of successful plans has 44 plans.
- **No mitigation is required.** Share of successful plans using each: scale workers 64/96, upgrade database 88/96, larger batches 56/96, limit retries 50/96, pause low-priority 56/96, rate limiting 50/96. The cheapest success (pause low-priority work and wait) uses no money at all but breaches the freshness SLO for 19 minutes; the freshest ones cost $1,168/month more and give up hundreds of thousands of jobs during the failover.

Best successful plan per measure:

| Measure | Plan | Cost/month | Complexity | SLO-violation min | Avg delay | Jobs given up |
| --- | --- | --- | --- | --- | --- | --- |
| Cost, spend, complexity, jobs given up | investigate workers + pause low-priority | $3,687 | 4 | 19 | 39 s | 0 |
| SLO-violation minutes | + scale workers + upgrade + batches + limit retries + clean-up | $4,855 | 5 | 2 | 13 s | 992k |
| Average delay | + scale workers ×2 + upgrade + limit retries + pause + clean-up | $4,855 | 4 | 2 | 9 s | 837k |

## Engine changes it needed

All generic; nothing in the engine knows this scenario.

- **Metrics**: `processingRate`, `processingDelay` (new unit `s`), `workerUtilization`, `retryRate`, `jobFailureRate`. The scenario's freshness SLO and objectives need a processing delay the engine can observe, and the guidance needs worker utilization in the timeline the same way application CPU is.
- **Queue retries**: a queue's `maxAttempts`. Consumers fail a delivery when they or what they call fail it; the queue puts that share back on its backlog. Without it, retry amplification could only be faked with events.
- **Capacity observation**: a `component` signal for `capacity`, so "how much can the workers process" can be a hidden fact.
- **Full queue**: retried messages take their place first, so a full queue rejects new work instead of silently losing retries.

The 10× Traffic Incident is unchanged: it never sets `maxAttempts`, so its queue never retries, and its numbers and tests are the same.
