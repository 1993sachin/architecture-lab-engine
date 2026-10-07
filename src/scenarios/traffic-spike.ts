import { defineScenario } from "../engine/scenario/define.ts";

/**
 * The 10× Traffic Incident.
 *
 * A read-heavy product API runs comfortably at 300 rps. Five minutes in, a
 * launch goes viral and traffic jumps tenfold. The engineer must keep the
 * service up within a budget that finance later cuts, without building more
 * than a small team can operate.
 */
export const trafficSpikeScenario = defineScenario({
  id: "traffic-spike",
  title: "The 10× Traffic Incident",
  description:
    "A read-heavy API is hit by a tenfold traffic spike. Keep latency and errors under control within budget and team capacity.",
  timeStep: 1,
  workload: { requestsPerSecond: 300, readRatio: 0.8 },
  resources: { engineerDays: 8 },
  initialState: {
    complexityScore: 3,
    components: [
      { id: "client", type: "client", label: "Users" },
      { id: "gateway", type: "apiGateway", label: "API Gateway" },
      { id: "lb", type: "loadBalancer", label: "Load Balancer" },
      { id: "app", type: "application", label: "Product API", instances: 4 },
      { id: "db", type: "database", label: "Primary Database" },
    ],
    dependencies: [
      { from: "client", to: "gateway" },
      { from: "gateway", to: "lb" },
      { from: "lb", to: "app" },
      { from: "app", to: "db", traffic: "read" },
      { from: "app", to: "db", traffic: "write" },
    ],
  },
  constraints: [
    { id: "budget", kind: "budget", description: "Monthly infrastructure budget", limit: 3000 },
    { id: "team", kind: "complexity", description: "What a team of four can operate", limit: 10 },
    { id: "latency-slo", kind: "metric", description: "p95 latency SLO", metric: "p95Latency", bound: "max", limit: 250 },
    { id: "availability-slo", kind: "metric", description: "Availability SLO", metric: "availability", bound: "min", limit: 0.99 },
  ],
  decisions: [
    {
      id: "scale-application",
      title: "Scale the application",
      description: "Add four application instances behind the load balancer.",
      immediateEffects: [{ type: "updateComponent", componentId: "app", instances: { add: 4, max: 40 } }],
      complexityImpact: 0,
      repeatable: true,
    },
    {
      id: "scale-down-application",
      title: "Scale the application down",
      description: "Remove two application instances to save cost.",
      prerequisites: [
        { condition: { type: "componentUtilization", componentId: "app", op: "<", value: 0.6 }, message: "The application is too busy to scale down safely." },
      ],
      immediateEffects: [{ type: "updateComponent", componentId: "app", instances: { add: -2, min: 2 } }],
      complexityImpact: 0,
      repeatable: true,
    },
    {
      id: "enable-cache",
      title: "Add a read-through cache",
      description: "Put Redis in front of the database for reads. It starts cold and warms up over a few minutes.",
      immediateEffects: [
        { type: "addComponent", component: { id: "cache", type: "cache", label: "Redis", configuration: { hitRate: 0.3 } } },
        { type: "redirect", target: "db", to: "cache", traffic: "read", fraction: 1 },
        { type: "connect", dependency: { from: "cache", to: "db", traffic: "read" } },
      ],
      ongoingEffects: [
        {
          id: "warm-up",
          description: "Cache warms up as hot keys are loaded.",
          effects: [{ type: "configure", componentId: "cache", key: "hitRate", change: { add: 0.1, max: 0.85 } }],
        },
      ],
      complexityImpact: 3,
      requires: { engineerDays: 2 },
      sideEffects: [
        {
          id: "invalidation",
          description: "Write-heavy traffic makes cache invalidation a recurring source of bugs.",
          when: { type: "workload", property: "readRatio", op: "<", value: 0.6 },
          effects: [{ type: "complexity", change: { add: 1 } }],
        },
      ],
    },
    {
      id: "enable-rate-limiting",
      title: "Enable rate limiting",
      description: "Reject traffic above 2,500 rps at the gateway to protect the backend.",
      immediateEffects: [{ type: "configure", componentId: "gateway", key: "rateLimit", value: 2500 }],
      complexityImpact: 1,
      sideEffects: [
        {
          id: "throttled-customers",
          description: "Some legitimate users are rejected with HTTP 429 while traffic exceeds the limit.",
          when: { type: "workload", property: "requestsPerSecond", op: ">", value: 2500 },
          effects: [{ type: "flag", flag: "customersThrottled", value: true }],
        },
      ],
    },
    {
      id: "add-database-replica",
      title: "Add a read replica",
      description: "Send half of the database reads to a replica.",
      immediateEffects: [
        { type: "addComponent", component: { id: "replica", type: "databaseReplica", label: "Read Replica" } },
        { type: "redirect", target: "db", to: "replica", traffic: "read", fraction: 0.5 },
      ],
      complexityImpact: 2,
      requires: { engineerDays: 2 },
    },
    {
      id: "increase-database-capacity",
      title: "Upgrade the database instance",
      description: "Move the primary to an instance with twice the capacity, at twice the price.",
      immediateEffects: [
        { type: "updateComponent", componentId: "db", capacity: { multiply: 2 }, costPerInstance: { multiply: 2 } },
      ],
      complexityImpact: 0,
    },
    {
      id: "enable-async-processing",
      title: "Process writes asynchronously",
      description: "Accept writes into a queue and apply them with background workers.",
      immediateEffects: [
        { type: "addComponent", component: { id: "queue", type: "queue", label: "Write Queue" } },
        { type: "addComponent", component: { id: "workers", type: "worker", label: "Write Workers", instances: 2 } },
        { type: "redirect", target: "db", to: "queue", traffic: "write", fraction: 1 },
        { type: "connect", dependency: { from: "queue", to: "workers", traffic: "write" } },
        { type: "connect", dependency: { from: "workers", to: "db", traffic: "write" } },
      ],
      complexityImpact: 4,
      requires: { engineerDays: 4 },
    },
  ],
  events: [
    {
      id: "traffic-spike",
      title: "Launch goes viral",
      description: "A celebrity shares the product. Traffic jumps tenfold.",
      trigger: { at: 5 },
      effects: [{ type: "workload", requestsPerSecond: { set: 3000 } }],
    },
    {
      id: "cache-eviction",
      title: "Cache eviction storm",
      description: "A deploy flushes a large part of the cache; the hit rate drops.",
      trigger: {
        when: { type: "all", conditions: [{ type: "time", op: ">=", value: 20 }, { type: "componentExists", componentId: "cache" }] },
      },
      effects: [{ type: "configure", componentId: "cache", key: "hitRate", change: { multiply: 0.5 } }],
    },
    {
      id: "budget-cut",
      title: "Finance cuts the budget",
      description: "The monthly infrastructure budget is reduced to $2,600.",
      trigger: { at: 25 },
      effects: [{ type: "updateConstraint", constraintId: "budget", limit: { set: 2600 } }],
    },
    {
      id: "traffic-settles",
      title: "Traffic settles",
      description: "The spike fades to a new normal of 2,000 rps.",
      trigger: { at: 35 },
      effects: [{ type: "workload", requestsPerSecond: { set: 2000 } }],
    },
  ],
  objectives: [
    { id: "latency", description: "p95 latency at or below 250 ms", condition: { type: "metric", metric: "p95Latency", op: "<=", value: 250 } },
    { id: "errors", description: "Error rate at or below 1%", condition: { type: "metric", metric: "errorRate", op: "<=", value: 0.01 } },
    {
      id: "database-headroom",
      description: "Database utilization at or below 80%",
      condition: { type: "metric", metric: "databaseUtilization", op: "<=", value: 0.8 },
    },
  ],
  completion: { maxDuration: 45 },
});
