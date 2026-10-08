import type { Playbook } from "../types/index.ts";

/**
 * Reference playbooks for "The Queue That Won't Drain": strategies an engineer
 * might follow, each reacting to what it could see at the time. Several
 * succeed with different trade-offs; the last one shows the trap of adding
 * workers in front of a database that cannot take more.
 */
export const queueWontDrainPlaybooks: Playbook[] = [
  {
    id: "A",
    name: "Scale the workers and the database",
    summary: "Treat it as a capacity problem on both tiers: more workers, and a database big enough to take their writes. Fast, but it costs money until the extra workers are removed.",
    steps: [
      { at: 15, decision: "investigate-workers", rationale: "The queue is growing; check whether the workers are the limit." },
      { at: 17, decision: "investigate-database", rationale: "Workers are at 100%. Before adding more, check whether PostgreSQL can take their writes." },
      { at: 19, decision: "upgrade-database", rationale: "PostgreSQL is already past capacity; more workers would only fail more writes." },
      { at: 19, decision: "scale-workers", rationale: "Workers are saturated; add processing capacity now that the database is being upgraded." },
      { at: 42, decision: "scale-down-workers", rationale: "The backlog is gone; give the extra workers back to get under budget." },
    ],
  },
  {
    id: "B",
    name: "Shed load and stop the retry storm",
    summary: "Spend nothing: pause low-priority producers, stop failed jobs from coming back again and again, and resume before the deadline. Cheap, but slower to recover and more jobs end up in the dead-letter queue.",
    steps: [
      { at: 15, decision: "investigate-workers", rationale: "The queue is growing; check whether the workers are the limit." },
      { at: 17, decision: "pause-low-priority", rationale: "Workers are saturated. Re-indexing and digests can wait; customer jobs cannot." },
      { at: 17, decision: "investigate-failures", rationale: "Processing rate is above the job rate, yet the queue keeps growing. Where is the extra work coming from?" },
      { at: 19, decision: "limit-retries", rationale: "A share of the workers' effort is repeats of failing jobs; cap them so the workers do new work." },
      { at: 37, decision: "resume-low-priority", rationale: "The backlog is down and the deadline is T+38." },
    ],
  },
  {
    id: "C",
    name: "Bigger database, bigger batches",
    summary: "Make each worker do more: a larger database to absorb the writes and larger batches for throughput, with low-priority work paused for a while. No extra workers, but more complexity and a database that stays expensive.",
    steps: [
      { at: 15, decision: "investigate-database", rationale: "Every job writes to PostgreSQL; check it before touching the workers." },
      { at: 17, decision: "upgrade-database", rationale: "PostgreSQL is past capacity and failing writes." },
      { at: 17, decision: "pause-low-priority", rationale: "Buy time while the failover runs." },
      { at: 18, decision: "increase-batch-size", rationale: "Workers are at their limit; process more jobs per worker instead of paying for more workers." },
      { at: 37, decision: "resume-low-priority", rationale: "The backlog is down and the deadline is T+38." },
    ],
  },
  {
    id: "D",
    name: "Throttle intake while the database is upgraded",
    summary: "Stop the queue growing at once by rejecting excess jobs at the API, fix the database behind it, then lift the limit. Freshness recovers quickly, but producers see errors and the API breaches its SLO while the limit is on.",
    steps: [
      { at: 15, decision: "enable-rate-limiting", rationale: "Stop the backlog growing while we find out why." },
      { at: 15, decision: "investigate-database", rationale: "Every job writes to PostgreSQL; check it." },
      { at: 17, decision: "upgrade-database", rationale: "PostgreSQL is past capacity and failing writes." },
      { at: 18, decision: "increase-batch-size", rationale: "Workers are saturated; get more out of each one." },
      { at: 27, decision: "remove-rate-limit", rationale: "The queue is draining; accept every job again." },
    ],
  },
  {
    id: "E",
    name: "Just add workers",
    summary: "The queue is growing, so add workers, twice. It feels obvious, but every extra worker sends more writes to a database that is already failing them, and the retries eat the new capacity.",
    steps: [
      { at: 15, decision: "scale-workers", rationale: "The queue is growing: we need more workers." },
      { at: 17, decision: "scale-workers", rationale: "Still growing: more workers." },
    ],
  },
];
