import { defineScenario } from "../engine/scenario/define.ts";

/**
 * The Queue That Won't Drain.
 *
 * An asynchronous job service (Producers → Jobs API → Job Queue → Workers →
 * PostgreSQL). The API only accepts a job and puts it on the queue, so it stays
 * fast and available while the real trouble builds up behind it: from T+3 the
 * job rate climbs until it passes what the workers can process, the queue grows, and jobs
 * wait longer and longer before anyone works on them.
 *
 * At T+16 month-end reporting starts on the same PostgreSQL, which leaves less
 * room for the workers' writes. Writes that fail are retried by the queue (up to
 * six deliveries), so a struggling database turns into extra work for the
 * workers and the database at once.
 *
 * What is hidden: how busy the workers are and how much they can process, how
 * busy PostgreSQL is, and how much of the workers' effort goes into retries.
 *
 * Numbers are illustrative and internally consistent, not real cloud pricing.
 */
export const queueWontDrainScenario = defineScenario({
  id: "queue-wont-drain",
  title: "The Queue That Won't Drain",
  description:
    "Jobs arrive faster than workers can finish them. The API looks healthy while work quietly piles up behind it. Keep processing fresh without losing jobs or blowing the budget.",
  timeStep: 1,
  observations: [
    { id: "incoming-jobs", label: "Incoming jobs", signal: { kind: "metric", metric: "requestsPerSecond" } },
    { id: "api-latency", label: "API p99 latency", signal: { kind: "metric", metric: "p99Latency" } },
    { id: "api-errors", label: "API error rate", signal: { kind: "metric", metric: "errorRate" } },
    { id: "throttle-rate", label: "Rejected by rate limit", signal: { kind: "metric", metric: "throttleRate" } },
    { id: "queue-depth", label: "Job queue depth", signal: { kind: "metric", metric: "queueDepth" } },
    { id: "processing-rate", label: "Processing rate", signal: { kind: "metric", metric: "processingRate" } },
    { id: "processing-delay", label: "Processing delay", signal: { kind: "metric", metric: "processingDelay" } },
    { id: "monthly-cost", label: "Monthly cost", signal: { kind: "metric", metric: "monthlyCost" } },
    // Hidden until investigated.
    {
      id: "worker-utilization",
      label: "Worker utilization",
      signal: { kind: "metric", metric: "workerUtilization" },
      visible: false,
      description: "How much of the workers' processing capacity is in use. At 100% they cannot take on any more, however much is waiting.",
    },
    {
      id: "worker-capacity",
      label: "Worker processing capacity",
      signal: { kind: "component", componentId: "workers", property: "capacity" },
      visible: false,
      description: "Deliveries per second all workers together can process.",
    },
    {
      id: "database-utilization",
      label: "PostgreSQL CPU",
      signal: { kind: "metric", metric: "databaseUtilization" },
      visible: false,
      description: "Every job ends with a write to PostgreSQL. Above 100% it fails writes, and a failed write fails the job.",
    },
    {
      id: "database-latency",
      label: "PostgreSQL write latency",
      signal: { kind: "component", componentId: "db", property: "latencyMs" },
      visible: false,
      description: "How long the workers wait for each write.",
    },
    {
      id: "retry-rate",
      label: "Deliveries that are retries",
      signal: { kind: "metric", metric: "retryRate" },
      visible: false,
      description: "Of everything the workers process, the share that is a job being tried again after it failed.",
    },
    {
      id: "job-failure-rate",
      label: "Jobs given up on",
      signal: { kind: "metric", metric: "jobFailureRate" },
      visible: false,
      description: "Jobs that failed every delivery and were moved to the dead-letter queue for someone to replay later.",
    },
    {
      id: "max-attempts",
      label: "Deliveries per job before giving up",
      signal: { kind: "configuration", componentId: "queue", key: "maxAttempts" },
      visible: false,
      description: "A failed job goes back on the queue and is tried again, up to this many times.",
    },
  ],
  workload: { requestsPerSecond: 5000, readRatio: 0 },
  initialState: {
    complexityScore: 4,
    flags: { lowPriorityPaused: false, databaseTier: "standard", batchSize: "small" },
    components: [
      { id: "client", type: "client", label: "Producers" },
      { id: "api", type: "apiGateway", label: "Jobs API", capacity: 60000, baseLatencyMs: 18, cost: { hourly: 0.2 } },
      {
        id: "queue",
        type: "queue",
        label: "Job Queue",
        capacity: 200000,
        cost: { hourly: 0.25 },
        // Room for about four million jobs; failed jobs are delivered up to six times.
        configuration: { maxDepth: 4000000, maxAttempts: 6 },
      },
      {
        id: "workers",
        type: "worker",
        label: "Workers",
        instances: 12,
        capacity: 580,
        baseLatencyMs: 120,
        cost: { hourly: 0.25 },
        // A few jobs fail on their own (bad payloads, timeouts to other services) and are retried.
        configuration: { baseErrorRate: 0.01 },
      },
      { id: "db", type: "database", label: "PostgreSQL", capacity: 7600, baseLatencyMs: 6, cost: { hourly: 1.6 }, configuration: { writeCost: 1 } },
    ],
    dependencies: [
      { from: "client", to: "api" },
      { from: "api", to: "queue" },
      { from: "queue", to: "workers" },
      { from: "workers", to: "db" },
    ],
  },
  constraints: [
    {
      id: "budget",
      kind: "budget",
      description: "Monthly run-rate agreed with finance. Overspending during the incident is tolerated but recorded.",
      limit: 5000,
      enforcement: "monitor",
    },
    { id: "team", kind: "complexity", description: "What the on-call team can safely operate", limit: 8 },
    { id: "freshness-slo", kind: "metric", description: "Freshness SLO: jobs start processing within 60 seconds", metric: "processingDelay", bound: "max", limit: 60 },
    { id: "api-availability-slo", kind: "metric", description: "API availability SLO (rejected jobs count as unavailable)", metric: "availability", bound: "min", limit: 0.99 },
    {
      id: "low-priority-deadline",
      kind: "deadline",
      description: "Search re-indexing and digest emails must be running again by T+38 so they finish overnight",
      limit: 38,
      condition: { type: "flag", flag: "lowPriorityPaused", equals: false },
    },
  ],
  decisions: [
    {
      id: "investigate-workers",
      title: "Investigate the workers",
      description: "Look at worker utilization and how many jobs per second the worker fleet can process. Takes two minutes.",
      immediateEffects: [],
      complexityImpact: 0,
      reveals: ["worker-utilization", "worker-capacity"],
      duration: 2,
    },
    {
      id: "investigate-failures",
      title: "Investigate failing jobs",
      description: "Look at retries and the dead-letter queue: how much of the workers' effort is repeats, and how many jobs are given up on. Takes two minutes.",
      immediateEffects: [],
      complexityImpact: 0,
      reveals: ["retry-rate", "job-failure-rate", "max-attempts"],
      duration: 2,
    },
    {
      id: "investigate-database",
      title: "Investigate the database",
      description: "Look at PostgreSQL CPU and how long the workers' writes take. Takes two minutes.",
      immediateEffects: [],
      complexityImpact: 0,
      reveals: ["database-utilization", "database-latency"],
      duration: 2,
    },
    {
      id: "scale-workers",
      title: "Scale the workers",
      description: "Add six worker instances (+3,480 jobs/s of processing capacity).",
      immediateEffects: [{ type: "updateComponent", componentId: "workers", instances: { add: 6, max: 36 } }],
      complexityImpact: 0,
      repeatable: true,
    },
    {
      id: "scale-down-workers",
      title: "Scale the workers down",
      description: "Remove six worker instances to save cost.",
      prerequisites: [
        { condition: { type: "componentExists", componentId: "workers" } },
        { condition: { type: "metric", metric: "queueDepth", op: "<", value: 50000 }, message: "Jobs are still waiting in the queue; the workers are needed to drain it." },
      ],
      immediateEffects: [{ type: "updateComponent", componentId: "workers", instances: { add: -6, min: 12 } }],
      complexityImpact: 0,
      repeatable: true,
    },
    {
      id: "increase-batch-size",
      title: "Increase the worker batch size",
      description:
        "Workers take 50 jobs at a time instead of 10 and write them in one transaction. More jobs per second for the same workers and fewer database round trips, but each batch takes longer, uses more memory, and one bad job fails its whole batch.",
      prerequisites: [{ condition: { type: "flag", flag: "batchSize", equals: "small" }, message: "Workers already use large batches." }],
      immediateEffects: [
        { type: "updateComponent", componentId: "workers", capacity: { multiply: 1.4 }, baseLatencyMs: { multiply: 3 } },
        { type: "configure", componentId: "db", key: "writeCost", change: { multiply: 1 } },
        { type: "configure", componentId: "workers", key: "baseErrorRate", change: { add: 0.08 } },
        { type: "flag", flag: "batchSize", value: "large" },
      ],
      complexityImpact: 1,
      sideEffects: [
        { id: "batch-memory", description: "Each worker holds a whole batch in memory; a crash loses more work in progress.", effects: [{ type: "flag", flag: "largeBatches", value: true }] },
      ],
    },
    {
      id: "limit-retries",
      title: "Limit retries",
      description: "Deliver a failed job at most twice, with backoff, then move it to the dead-letter queue. Less repeated work, but more jobs are given up on and need replaying later.",
      prerequisites: [{ condition: { type: "not", condition: { type: "decisionTaken", decisionId: "limit-retries" } }, message: "Retries are already limited." }],
      immediateEffects: [{ type: "configure", componentId: "queue", key: "maxAttempts", value: 2 }],
      complexityImpact: 0,
    },
    {
      id: "pause-low-priority",
      title: "Pause low-priority work",
      description: "Stop the producers of search re-indexing and digest emails, about a fifth of all jobs. They must be running again by T+38.",
      prerequisites: [{ condition: { type: "flag", flag: "lowPriorityPaused", equals: false }, message: "Low-priority work is already paused." }],
      immediateEffects: [
        { type: "workload", requestsPerSecond: { multiply: 0.8 } },
        { type: "flag", flag: "lowPriorityPaused", value: true },
      ],
      complexityImpact: 0,
    },
    {
      id: "resume-low-priority",
      title: "Resume low-priority work",
      description: "Start the search re-indexing and digest email producers again.",
      prerequisites: [{ condition: { type: "flag", flag: "lowPriorityPaused", equals: true }, message: "Low-priority work is not paused." }],
      immediateEffects: [
        { type: "workload", requestsPerSecond: { multiply: 1.25 } },
        { type: "flag", flag: "lowPriorityPaused", value: false },
      ],
      complexityImpact: 0,
    },
    {
      id: "enable-rate-limiting",
      title: "Rate-limit incoming jobs",
      description: "Accept at most 7,000 jobs/s at the API and reject the rest with HTTP 429. Producers have to try again later; rejected jobs count against API availability.",
      prerequisites: [{ condition: { type: "not", condition: { type: "decisionTaken", decisionId: "enable-rate-limiting" } }, message: "Rate limiting is already enabled." }],
      immediateEffects: [{ type: "configure", componentId: "api", key: "rateLimit", value: 7000 }],
      complexityImpact: 1,
    },
    {
      id: "remove-rate-limit",
      title: "Remove the rate limit",
      description: "Accept every job at the API again.",
      prerequisites: [{ condition: { type: "decisionTaken", decisionId: "enable-rate-limiting" }, message: "Rate limiting is not enabled." }],
      immediateEffects: [{ type: "configure", componentId: "api", key: "rateLimit", value: 0 }],
      complexityImpact: -1,
    },
    {
      id: "upgrade-database",
      title: "Upgrade the PostgreSQL instance",
      description: "Fail over to an instance with twice the capacity at twice the price. The primary is degraded for three minutes during the failover.",
      prerequisites: [
        { condition: { type: "flag", flag: "databaseTier", equals: "standard" }, message: "PostgreSQL is already on the larger instance." },
        { condition: { type: "componentHealth", componentId: "db", health: "healthy" }, message: "A failover is already in progress." },
      ],
      immediateEffects: [
        { type: "setHealth", componentId: "db", health: "degraded" },
        { type: "updateComponent", componentId: "db", costPerInstance: { multiply: 2 } },
        { type: "flag", flag: "databaseTier", value: "large" },
      ],
      ongoingEffects: [
        {
          id: "failover",
          description: "The failover completes and the larger instance takes traffic.",
          interval: 3,
          duration: 3,
          effects: [
            { type: "updateComponent", componentId: "db", capacity: { multiply: 2 } },
            { type: "setHealth", componentId: "db", health: "healthy" },
          ],
        },
      ],
      complexityImpact: 0,
    },
  ],
  events: [
    {
      id: "workload-rises",
      title: "Job volume starts rising",
      description: "A large customer starts importing its catalogue. Jobs are arriving faster each minute.",
      trigger: { at: 3 },
      effects: [],
      ongoingEffects: [
        {
          id: "import-ramp",
          description: "The job rate grows by about 6% a minute.",
          effects: [{ type: "workload", requestsPerSecond: { multiply: 1.06 } }],
          duration: 9,
        },
      ],
    },
    {
      id: "month-end-reporting",
      title: "Month-end reporting starts",
      description: "Finance's month-end reports start running on the same PostgreSQL. They take 10% of its capacity until they finish.",
      trigger: { at: 16 },
      effects: [{ type: "updateComponent", componentId: "db", capacity: { multiply: 0.9 } }],
    },
    {
      id: "import-slows",
      title: "The import slows down",
      description: "The customer's import is past its largest batches. The job rate eases back down.",
      trigger: { at: 30 },
      effects: [],
      ongoingEffects: [
        {
          id: "import-ease",
          description: "The job rate falls by about 3% a minute.",
          effects: [{ type: "workload", requestsPerSecond: { multiply: 0.97 } }],
          duration: 12,
        },
      ],
    },
    {
      id: "reporting-ends",
      title: "Month-end reporting finishes",
      description: "The reports are done; PostgreSQL's full capacity is available to the workers again.",
      trigger: { at: 40 },
      effects: [{ type: "updateComponent", componentId: "db", capacity: { multiply: 1 / 0.9 } }],
    },
  ],
  objectives: [
    {
      id: "fresh",
      description: "Jobs start processing within 60 seconds for 60% of the incident",
      condition: { type: "metric", metric: "processingDelay", op: "<=", value: 60 },
      evaluation: "fractionOfTime",
      threshold: 0.6,
      weight: 2,
    },
    {
      id: "jobs-succeed",
      description: "At most 2% of jobs given up on, for 80% of the incident",
      condition: { type: "metric", metric: "jobFailureRate", op: "<=", value: 0.02 },
      evaluation: "fractionOfTime",
      threshold: 0.8,
    },
    {
      id: "api-available",
      description: "The API accepts at least 99% of jobs for 70% of the incident",
      condition: { type: "metric", metric: "availability", op: ">=", value: 0.99 },
      evaluation: "fractionOfTime",
      threshold: 0.7,
    },
    {
      id: "drained",
      description: "At the end: fewer than 100,000 jobs waiting",
      condition: { type: "metric", metric: "queueDepth", op: "<", value: 100000 },
    },
  ],
  businessImpact: { valuePerFailedRequest: 0.01, valuePerThrottledRequest: 0.004 },
  completion: { maxDuration: 50, failWhen: { type: "metric", metric: "availability", op: "<", value: 0.6 } },
});
