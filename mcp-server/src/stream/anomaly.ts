/**
 * Anomaly detection — threshold rules applied to windows.
 *
 * Each rule checks the current window (and optionally recent history)
 * against baselines or absolute thresholds. Returns an Anomaly if
 * something is wrong, null if everything is fine.
 *
 * Cooldowns prevent re-firing the same anomaly type within a window.
 */

import type { Window } from "./window.js";
import type { BaselineState } from "./baseline.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Anomaly {
  rule: string;
  severity: "warning" | "critical";
  description: string;
  index?: string;
  node?: string;
}

export interface DetectionContext {
  current: Window;
  recent: Window[];       // last N windows, newest first (includes current)
  baseline: BaselineState;
}

interface AnomalyRule {
  name: string;
  check: (ctx: DetectionContext) => Anomaly[];
}

// ---------------------------------------------------------------------------
// Detector — stateless, just runs rules
// ---------------------------------------------------------------------------

export class AnomalyDetector {
  detect(ctx: DetectionContext): Anomaly[] {
    const results: Anomaly[] = [];
    for (const rule of rules) {
      results.push(...rule.check(ctx));
    }
    return results;
  }
}

/** Key that uniquely identifies an anomaly target (for locking). */
export function anomalyKey(a: Anomaly): string {
  return `${a.rule}:${a.index ?? ""}:${a.node ?? ""}`;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const rules: AnomalyRule[] = [
  {
    name: "cluster_red",
    check: (ctx) => {
      if (ctx.current.cluster.health === "red") {
        return [{
          rule: "cluster_red",
          severity: "critical",
          description: `Cluster health RED — ${ctx.current.cluster.unassignedShards} unassigned shards`,
        }];
      }
      return [];
    },
  },

  {
    name: "cluster_yellow",
    check: (ctx) => {
      if (ctx.current.cluster.health !== "yellow") return [];
      // Fire once baseline is ready (cooldown prevents re-firing).
      // On small clusters yellow is the primary signal.
      if (!ctx.baseline.ready) return [];
      return [{
        rule: "cluster_yellow",
        severity: "warning",
        description: `Cluster health YELLOW — ${ctx.current.cluster.unassignedShards} unassigned shards`,
      }];
    },
  },

  {
    name: "node_drop",
    check: (ctx) => {
      if (!ctx.baseline.ready) return [];
      const expected = Math.round(ctx.baseline.nodes);
      const actual = ctx.current.cluster.nodes;
      if (actual < expected) {
        return [{
          rule: "node_drop",
          severity: "critical",
          description: `Node count dropped: ${actual} (expected ${expected})`,
        }];
      }
      return [];
    },
  },

  {
    name: "heap_pressure",
    check: (ctx) => {
      const results: Anomaly[] = [];
      for (const node of ctx.current.nodes) {
        // Sustained check: must be high in current AND previous window
        if (node.heapPercent > 85 && isSustained(ctx, (w) =>
          (w.nodes.find((n) => n.name === node.name)?.heapPercent ?? 0) > 85,
        )) {
          results.push({
            rule: "heap_pressure",
            severity: node.heapPercent > 92 ? "critical" : "warning",
            description: `${node.name} heap at ${node.heapPercent}%`,
            node: node.name,
          });
        }
      }
      return results;
    },
  },

  {
    name: "thread_pool_saturation",
    check: (ctx) => {
      const results: Anomaly[] = [];
      for (const node of ctx.current.nodes) {
        if (node.searchThreadPoolQueue > 0 && isSustained(ctx, (w) =>
          (w.nodes.find((n) => n.name === node.name)?.searchThreadPoolQueue ?? 0) > 0,
        )) {
          results.push({
            rule: "thread_pool_saturation",
            severity: "warning",
            description: `${node.name} search queue ${node.searchThreadPoolQueue} (sustained)`,
            node: node.name,
          });
        }
        if (node.searchThreadPoolRejected > 0) {
          results.push({
            rule: "thread_pool_saturation",
            severity: "critical",
            description: `${node.name} search rejections: ${node.searchThreadPoolRejected}`,
            node: node.name,
          });
        }
      }
      return results;
    },
  },

  {
    name: "latency_spike",
    check: (ctx) => {
      if (!ctx.baseline.ready) return [];
      const results: Anomaly[] = [];
      for (const [idx, iw] of Object.entries(ctx.current.indices)) {
        if (iw.queryCount === 0) continue; // no traffic, no problem
        const bl = ctx.baseline.indices.get(idx);

        // New traffic on a previously-idle index — treat as anomaly if latency > 0.5ms
        if (!bl || bl.avgLatency === 0) {
          if (iw.avgLatency > 0.5) {
            results.push({
              rule: "latency_spike",
              severity: "warning",
              description: `${idx} new traffic with ${iw.avgLatency}ms avg latency`,
              index: idx,
            });
          }
          continue;
        }

        const ratio = iw.avgLatency / bl.avgLatency;
        if (ratio > 4) {
          results.push({
            rule: "latency_spike",
            severity: "critical",
            description: `${idx} avg latency ${iw.avgLatency}ms (baseline ${Math.round(bl.avgLatency)}ms, ${ratio.toFixed(1)}x)`,
            index: idx,
          });
        } else if (ratio > 2) {
          results.push({
            rule: "latency_spike",
            severity: "warning",
            description: `${idx} avg latency ${iw.avgLatency}ms (baseline ${Math.round(bl.avgLatency)}ms, ${ratio.toFixed(1)}x)`,
            index: idx,
          });
        }
      }
      return results;
    },
  },

  {
    name: "query_rate_spike",
    check: (ctx) => {
      if (!ctx.baseline.ready) return [];
      const results: Anomaly[] = [];
      for (const [idx, iw] of Object.entries(ctx.current.indices)) {
        const bl = ctx.baseline.indices.get(idx);

        // New traffic on idle index — fire if meaningful rate
        if (!bl || bl.queryRate < 0.1) {
          if (iw.queryRate >= 1) {
            results.push({
              rule: "query_rate_spike",
              severity: "warning",
              description: `${idx} new traffic: ${iw.queryRate} qps (was idle)`,
              index: idx,
            });
          }
          continue;
        }

        const ratio = iw.queryRate / bl.queryRate;
        if (ratio > 3) {
          results.push({
            rule: "query_rate_spike",
            severity: "warning",
            description: `${idx} query rate ${iw.queryRate} qps (baseline ${Math.round(bl.queryRate)} qps, ${ratio.toFixed(1)}x)`,
            index: idx,
          });
        }
      }
      return results;
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a condition held in at least 2 of the last 3 windows
 * (including current). Prevents alerting on single-window blips.
 */
function isSustained(
  ctx: DetectionContext,
  check: (w: Window) => boolean,
): boolean {
  const windowsToCheck = ctx.recent.slice(0, 3);
  const hits = windowsToCheck.filter(check).length;
  return hits >= 2;
}
