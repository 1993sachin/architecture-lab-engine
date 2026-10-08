import { defineScenario } from "../engine/scenario/define.ts";

/**
 * The 10× Traffic Incident.
 *
 * A product API (Client → API Gateway → Application Cluster → PostgreSQL)
 * serves 10,000 rps with the database at about 70% CPU. At T+3 a launch goes
 * viral: traffic reaches ~50,000 rps by T+6 and ~100,000 rps by T+13, holds,
 * then settles at a new normal of 30,000 rps from about T+29.
 *
 * Only headline metrics are visible. What the traffic is made of, how close
 * the database is to its limit, how expensive writes are and how much of the
 * read traffic a cache could serve must be investigated, which takes time while
 * the incident continues.
 *
 * Numbers are illustrative and internally consistent, not real cloud pricing.
 */
export const trafficIncidentScenario = defineScenario({
  id: "10x-traffic-incident",
  title: "The 10× Traffic Incident",
  description:
    "A product launch goes viral and traffic climbs to ten times normal. Keep the service up, protect the database, and finish within a budget that finance cuts halfway through.",
  timeStep: 1,
  observations: [
    { id: "request-rate", label: "Request rate", signal: { kind: "metric", metric: "requestsPerSecond" } },
    { id: "p99-latency", label: "p99 latency", signal: { kind: "metric", metric: "p99Latency" } },
    { id: "error-rate", label: "Error rate", signal: { kind: "metric", metric: "errorRate" } },
    { id: "throttle-rate", label: "Throttled requests", signal: { kind: "metric", metric: "throttleRate" } },
    { id: "app-cpu", label: "Application CPU", signal: { kind: "metric", metric: "cpuUtilization" } },
    { id: "monthly-cost", label: "Monthly cost", signal: { kind: "metric", metric: "monthlyCost" } },
    { id: "cache-hit-rate", label: "Cache hit rate", signal: { kind: "metric", metric: "cacheHitRate" } },
    { id: "queue-depth", label: "Write queue depth", signal: { kind: "metric", metric: "queueDepth" } },
    // Hidden until investigated.
    {
      id: "read-ratio",
      label: "Share of reads in traffic",
      signal: { kind: "workload", property: "readRatio" },
      visible: false,
      description: "The surge is almost entirely people reading pages, not writing data.",
    },
    {
      id: "cacheable-reads",
      label: "Share of reads that are cacheable",
      signal: { kind: "configuration", componentId: "app", key: "cacheableReads" },
      visible: false,
      format: "ratio",
      description: "Most reads hit the same popular pages, so a cache could answer them without PostgreSQL.",
    },
    {
      id: "database-cpu",
      label: "PostgreSQL CPU",
      signal: { kind: "metric", metric: "databaseUtilization" },
      visible: false,
      description: "PostgreSQL started the day at about 70% and has far less headroom than the application tier. Above 100% it fails requests.",
    },
    {
      id: "database-latency",
      label: "PostgreSQL query latency",
      signal: { kind: "component", componentId: "db", property: "latencyMs" },
      visible: false,
      description: "Slow queries hold application threads, which is where the p99 is going.",
    },
    {
      id: "write-cost",
      label: "Cost of a write relative to a read",
      signal: { kind: "configuration", componentId: "db", key: "writeCost" },
      visible: false,
      format: "multiplier",
      description: "Writes (inserts, indexes, WAL) are more expensive than reads. Replicas and caches do not take them off the primary.",
    },
  ],
  workload: { requestsPerSecond: 10000, readRatio: 0.8 },
  initialState: {
    complexityScore: 3,
    flags: { databaseTier: "standard" },
    components: [
      { id: "client", type: "client", label: "Users" },
      { id: "gateway", type: "apiGateway", label: "API Gateway", capacity: 250000, baseLatencyMs: 3, cost: { hourly: 0.15 } },
      {
        id: "app",
        type: "application",
        label: "Application Cluster",
        instances: 6,
        capacity: 5000,
        baseLatencyMs: 25,
        cost: { hourly: 0.1 },
        // `cacheableReads` is the ceiling a cache can reach; only an investigation shows it.
        configuration: { baseErrorRate: 0.001, cacheableReads: 0.9 },
      },
      {
        id: "db",
        type: "database",
        label: "PostgreSQL",
        capacity: 15000,
        baseLatencyMs: 17,
        cost: { hourly: 1.8 },
        // Writes (inserts, index maintenance, WAL) cost 25% more than a read.
        configuration: { readCost: 1, writeCost: 1.25 },
      },
    ],
    dependencies: [
      { from: "client", to: "gateway" },
      { from: "gateway", to: "app" },
      { from: "app", to: "db", traffic: "read" },
      { from: "app", to: "db", traffic: "write" },
    ],
  },
  constraints: [
    {
      id: "budget",
      kind: "budget",
      description: "Monthly infrastructure run-rate agreed with finance. Overspending during the incident is tolerated but recorded.",
      limit: 3500,
      enforcement: "monitor",
    },
    { id: "team", kind: "complexity", description: "What the on-call team can safely operate", limit: 10 },
    { id: "latency-slo", kind: "metric", description: "p99 latency SLO", metric: "p99Latency", bound: "max", limit: 500 },
    { id: "availability-slo", kind: "metric", description: "Availability SLO (rate-limited requests count as unavailable)", metric: "availability", bound: "min", limit: 0.99 },
  ],
  decisions: [
    {
      id: "investigate-traffic",
      title: "Investigate the traffic",
      description: "Break traffic down by endpoint: what share is reads, and how much of it would a cache serve. Takes two minutes.",
      immediateEffects: [],
      complexityImpact: 0,
      reveals: ["read-ratio", "cacheable-reads"],
      duration: 2,
    },
    {
      id: "investigate-database",
      title: "Investigate the database",
      description: "Look at PostgreSQL CPU, query latency and the slowest statements. Takes two minutes.",
      immediateEffects: [],
      complexityImpact: 0,
      reveals: ["database-cpu", "database-latency", "write-cost"],
      duration: 2,
    },
    {
      id: "scale-application",
      title: "Scale the application",
      description: "Add four application instances (+20,000 rps of application capacity).",
      immediateEffects: [{ type: "updateComponent", componentId: "app", instances: { add: 4, max: 40 } }],
      complexityImpact: 0,
      repeatable: true,
    },
    {
      id: "scale-down-application",
      title: "Scale the application down",
      description: "Remove four application instances to save cost.",
      prerequisites: [
        { condition: { type: "metric", metric: "cpuUtilization", op: "<", value: 0.6 }, message: "The application is too busy to remove four instances safely." },
      ],
      immediateEffects: [{ type: "updateComponent", componentId: "app", instances: { add: -4, min: 2 } }],
      complexityImpact: 0,
      repeatable: true,
    },
    {
      id: "enable-cache",
      title: "Add a Redis cache",
      description: "Serve reads from Redis and fall back to PostgreSQL on a miss. It starts cold and warms up over a few minutes; cached data can be slightly stale.",
      prerequisites: [{ condition: { type: "not", condition: { type: "componentExists", componentId: "cache" } }, message: "Redis is already in place." }],
      immediateEffects: [
        { type: "addComponent", component: { id: "cache", type: "cache", label: "Redis", capacity: 300000, cost: { hourly: 0.35 }, configuration: { hitRate: 0.2 } } },
        { type: "redirect", target: "db", to: "cache", traffic: "read", fraction: 1 },
        { type: "connect", dependency: { from: "cache", to: "db", traffic: "read" } },
      ],
      ongoingEffects: [
        {
          id: "warm-up",
          description: "Hot keys load into Redis; the hit rate climbs towards the share of reads that are cacheable.",
          effects: [{ type: "configure", componentId: "cache", key: "hitRate", change: { add: 0.14, max: 0.9 } }],
        },
      ],
      complexityImpact: 3,
      sideEffects: [
        {
          id: "stale-reads",
          description: "Users can see data up to a minute old; invalidation becomes something the team owns.",
          effects: [{ type: "flag", flag: "staleReads", value: true }],
        },
      ],
    },
    {
      id: "add-database-replica",
      title: "Add a read replica",
      description: "Send half of the database reads to a PostgreSQL replica. Writes still go to the primary; replicas lag slightly.",
      prerequisites: [{ condition: { type: "not", condition: { type: "componentExists", componentId: "replica" } }, message: "A replica is already running." }],
      immediateEffects: [
        { type: "addComponent", component: { id: "replica", type: "databaseReplica", label: "PostgreSQL Replica", capacity: 15000, baseLatencyMs: 17, cost: { hourly: 1.2 } } },
        { type: "redirect", target: "db", to: "replica", traffic: "read", fraction: 0.5 },
      ],
      complexityImpact: 2,
      sideEffects: [{ id: "replica-lag", description: "Reads from the replica can lag behind writes.", effects: [{ type: "flag", flag: "staleReads", value: true }] }],
    },
    {
      id: "remove-database-replica",
      title: "Remove the read replica",
      description: "Send every read back to the primary and stop paying for the replica.",
      prerequisites: [{ condition: { type: "componentExists", componentId: "replica" }, message: "There is no replica." }],
      immediateEffects: [
        { type: "redirect", target: "replica", to: "db", traffic: "read", fraction: 1 },
        { type: "removeComponent", componentId: "replica" },
      ],
      complexityImpact: -2,
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
    {
      id: "downgrade-database",
      title: "Downgrade the PostgreSQL instance",
      description: "Fail back to the standard instance to save cost. The primary is degraded for three minutes during the failover.",
      prerequisites: [
        { condition: { type: "flag", flag: "databaseTier", equals: "large" }, message: "PostgreSQL is already on the standard instance." },
        { condition: { type: "componentHealth", componentId: "db", health: "healthy" }, message: "A failover is already in progress." },
      ],
      immediateEffects: [
        { type: "setHealth", componentId: "db", health: "degraded" },
        { type: "updateComponent", componentId: "db", costPerInstance: { multiply: 0.5 } },
        { type: "flag", flag: "databaseTier", value: "standard" },
      ],
      ongoingEffects: [
        {
          id: "failover",
          description: "The failover completes and the standard instance takes traffic.",
          interval: 3,
          duration: 3,
          effects: [
            { type: "updateComponent", componentId: "db", capacity: { multiply: 0.5 } },
            { type: "setHealth", componentId: "db", health: "healthy" },
          ],
        },
      ],
      complexityImpact: 0,
    },
    {
      id: "enable-rate-limiting",
      title: "Enable rate limiting",
      description: "Reject traffic above 40,000 rps at the gateway with HTTP 429 to protect the backend.",
      prerequisites: [{ condition: { type: "not", condition: { type: "decisionTaken", decisionId: "enable-rate-limiting" } }, message: "Rate limiting is already enabled." }],
      immediateEffects: [{ type: "configure", componentId: "gateway", key: "rateLimit", value: 40000 }],
      complexityImpact: 1,
    },
    {
      id: "tighten-rate-limit",
      title: "Tighten the rate limit",
      description: "Lower the gateway limit by 10,000 rps (not below 10,000).",
      prerequisites: [{ condition: { type: "decisionTaken", decisionId: "enable-rate-limiting" }, message: "Rate limiting is not enabled." }],
      immediateEffects: [{ type: "configure", componentId: "gateway", key: "rateLimit", change: { add: -10000, min: 10000 } }],
      complexityImpact: 0,
      repeatable: true,
    },
    {
      id: "relax-rate-limit",
      title: "Relax the rate limit",
      description: "Raise the gateway limit by 10,000 rps.",
      prerequisites: [{ condition: { type: "decisionTaken", decisionId: "enable-rate-limiting" }, message: "Rate limiting is not enabled." }],
      immediateEffects: [{ type: "configure", componentId: "gateway", key: "rateLimit", change: { add: 10000, max: 200000 } }],
      complexityImpact: 0,
      repeatable: true,
    },
    {
      id: "enable-async-writes",
      title: "Queue writes asynchronously",
      description: "Accept writes into a queue and apply them with background workers at up to 4,000 writes/s. Writes become eventually consistent.",
      prerequisites: [{ condition: { type: "not", condition: { type: "componentExists", componentId: "queue" } }, message: "Writes are already queued." }],
      immediateEffects: [
        { type: "addComponent", component: { id: "queue", type: "queue", label: "Write Queue", capacity: 200000, cost: { hourly: 0.2 }, configuration: { maxDepth: 3000000 } } },
        { type: "addComponent", component: { id: "workers", type: "worker", label: "Write Workers", instances: 2, capacity: 2000, cost: { hourly: 0.1 } } },
        { type: "redirect", target: "db", to: "queue", traffic: "write", fraction: 1 },
        { type: "connect", dependency: { from: "queue", to: "workers", traffic: "write" } },
        { type: "connect", dependency: { from: "workers", to: "db", traffic: "write" } },
      ],
      complexityImpact: 4,
      sideEffects: [
        { id: "eventual-consistency", description: "A user's own writes may not be visible immediately.", effects: [{ type: "flag", flag: "eventualConsistency", value: true }] },
      ],
    },
  ],
  events: [
    {
      id: "launch-goes-viral",
      title: "Launch goes viral",
      description: "A product launch is trending. Traffic is up 50% and climbing fast.",
      trigger: { at: 3 },
      effects: [{ type: "workload", requestsPerSecond: { set: 15000 }, readRatio: { set: 0.94 } }],
      ongoingEffects: [
        {
          id: "first-wave",
          description: "Traffic climbs by about 12,000 rps a minute to 50,000 rps.",
          effects: [{ type: "workload", requestsPerSecond: { add: 12000, max: 50000 } }],
          until: { type: "workload", property: "requestsPerSecond", op: ">=", value: 50000 },
        },
      ],
    },
    {
      id: "second-wave",
      title: "Second wave",
      description: "Coverage spreads to another region. Traffic resumes climbing towards 100,000 rps.",
      trigger: { at: 8 },
      effects: [],
      ongoingEffects: [
        {
          id: "climb",
          description: "Traffic climbs by 10,000 rps a minute to 100,000 rps.",
          effects: [{ type: "workload", requestsPerSecond: { add: 10000, max: 100000 } }],
          until: { type: "workload", property: "requestsPerSecond", op: ">=", value: 100000 },
        },
      ],
    },
    {
      id: "cache-eviction",
      title: "Cache eviction storm",
      description: "A deploy restarts half of the Redis nodes; the hit rate halves and has to warm up again.",
      trigger: { when: { type: "all", conditions: [{ type: "time", op: ">=", value: 18 }, { type: "componentExists", componentId: "cache" }] } },
      effects: [{ type: "configure", componentId: "cache", key: "hitRate", change: { multiply: 0.5 } }],
    },
    {
      id: "peak-passes",
      title: "The peak passes",
      description: "Interest cools. Traffic declines towards a new normal of 30,000 rps.",
      trigger: { at: 22 },
      effects: [],
      ongoingEffects: [
        {
          id: "decline",
          description: "Traffic falls by 10,000 rps a minute to 30,000 rps.",
          effects: [{ type: "workload", requestsPerSecond: { add: -10000, min: 30000 }, readRatio: { set: 0.9 } }],
          until: { type: "workload", property: "requestsPerSecond", op: "<=", value: 30000 },
        },
      ],
    },
    {
      id: "budget-cut",
      title: "Finance lowers the budget",
      description:
        "The platform team moves to a shared cost allocation model. This service's run-rate must come down to $2,800/month and stay there once traffic settles.",
      trigger: { at: 25 },
      effects: [{ type: "updateConstraint", constraintId: "budget", limit: { set: 2800 } }],
    },
  ],
  objectives: [
    {
      id: "users-served",
      description: "At least 95% of requests succeed (throttled requests count as failures) for 70% of the incident",
      condition: { type: "metric", metric: "availability", op: ">=", value: 0.95 },
      evaluation: "fractionOfTime",
      threshold: 0.7,
      weight: 2,
    },
    {
      id: "no-collapse",
      description: "Server errors at or below 2% for 80% of the incident",
      condition: { type: "metric", metric: "serverErrorRate", op: "<=", value: 0.02 },
      evaluation: "fractionOfTime",
      threshold: 0.8,
    },
    {
      id: "responsive",
      description: "p99 latency at or below 500 ms for 70% of the incident",
      condition: { type: "metric", metric: "p99Latency", op: "<=", value: 500 },
      evaluation: "fractionOfTime",
      threshold: 0.7,
    },
    {
      id: "recovered",
      description: "At the end: p99 latency at or below 300 ms and error rate at or below 1%",
      condition: {
        type: "all",
        conditions: [
          { type: "metric", metric: "p99Latency", op: "<=", value: 300 },
          { type: "metric", metric: "errorRate", op: "<=", value: 0.01 },
        ],
      },
    },
    {
      id: "database-headroom",
      description: "At the end: PostgreSQL CPU at or below 80%",
      condition: { type: "metric", metric: "databaseUtilization", op: "<=", value: 0.8 },
    },
  ],
  businessImpact: { valuePerFailedRequest: 0.002, valuePerThrottledRequest: 0.001 },
  completion: { maxDuration: 45 },
});
