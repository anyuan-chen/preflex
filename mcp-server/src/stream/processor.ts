/**
 * Stream processor — polls ES APIs on a timer, computes windowed stats.
 *
 * Every 10s, polls node stats + index stats.
 * Every 30s (3 polls), rolls up into a Window and pushes to the ring buffer.
 *
 * Does NOT do anomaly detection or agent invocation — that's a separate layer.
 * This module is purely: poll → aggregate → store.
 */

import { esFetch } from "../es-client.js";
import {
  type Window,
  type IndexWindow,
  type NodeWindow,
  type ClusterSnapshot,
  RingBuffer,
} from "./window.js";

// ---------------------------------------------------------------------------
// Raw ES response shapes (only the fields we use)
// ---------------------------------------------------------------------------

interface NodeStatsResponse {
  nodes: Record<
    string,
    {
      name: string;
      os?: { cpu?: { percent?: number } };
      jvm?: { mem?: { heap_used_percent?: number } };
      thread_pool?: {
        search?: {
          active?: number;
          queue?: number;
          rejected?: number;
        };
      };
    }
  >;
}

interface IndexStatsResponse {
  indices: Record<
    string,
    {
      total: {
        search?: {
          query_total?: number;
          query_time_in_millis?: number;
        };
      };
    }
  >;
}

interface ClusterHealthResponse {
  status: "green" | "yellow" | "red";
  number_of_nodes: number;
  active_shards: number;
  unassigned_shards: number;
  indices?: Record<
    string,
    {
      status: "green" | "yellow" | "red";
      number_of_shards: number;
      active_shards: number;
      unassigned_shards: number;
    }
  >;
}

// ---------------------------------------------------------------------------
// Per-poll snapshot (raw, before delta computation)
// ---------------------------------------------------------------------------

interface PollSnapshot {
  timestamp: number;
  nodeStats: NodeStatsResponse;
  clusterHealth: ClusterHealthResponse;
  perIndexQueryTotal: Record<string, number>;
  perIndexQueryTime: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

export class StreamProcessor {
  readonly windows: RingBuffer<Window>;
  private prevPoll: PollSnapshot | null = null;
  private pollAccumulator: PollSnapshot[] = [];

  constructor(windowCapacity = 30) {
    this.windows = new RingBuffer<Window>(windowCapacity);
  }

  /**
   * Execute one poll cycle. Call this every ~10s.
   * Every 3rd poll, a new Window is computed and pushed.
   * Returns the new Window if one was created, else null.
   */
  async poll(): Promise<Window | null> {
    const snapshot = await this.fetchSnapshot();
    this.pollAccumulator.push(snapshot);

    if (this.pollAccumulator.length >= 3) {
      const window = this.computeWindow(this.pollAccumulator);
      this.windows.push(window);
      this.prevPoll = this.pollAccumulator[this.pollAccumulator.length - 1];
      this.pollAccumulator = [];
      return window;
    }

    return null;
  }

  /**
   * One-shot: poll everything once and immediately produce a window.
   * Useful for "show me what's happening right now" without waiting 30s.
   */
  async snapshot(): Promise<Window> {
    const snap = await this.fetchSnapshot();
    const window = this.computeWindow([snap]);
    this.windows.push(window);
    this.prevPoll = snap;
    return window;
  }

  // -------------------------------------------------------------------------
  // Fetch raw data from ES
  // -------------------------------------------------------------------------

  private async fetchSnapshot(): Promise<PollSnapshot> {
    const [nodeStats, clusterHealth, indexStats] = await Promise.all([
      esFetch<NodeStatsResponse>(
        "GET",
        "/_nodes/stats/jvm,os,thread_pool",
      ),
      esFetch<ClusterHealthResponse>("GET", "/_cluster/health?level=indices"),
      esFetch<IndexStatsResponse>("GET", "/_stats/search"),
    ]);

    // Extract real per-index query_total and query_time from /_stats/search.
    const perIndexQueryTotal: Record<string, number> = {};
    const perIndexQueryTime: Record<string, number> = {};
    for (const [idx, stats] of Object.entries(indexStats.indices ?? {})) {
      if (idx.startsWith(".")) continue; // skip system indices
      perIndexQueryTotal[idx] = stats.total.search?.query_total ?? 0;
      perIndexQueryTime[idx] = stats.total.search?.query_time_in_millis ?? 0;
    }

    return {
      timestamp: Date.now(),
      nodeStats,
      clusterHealth,
      perIndexQueryTotal,
      perIndexQueryTime,
    };
  }

  // -------------------------------------------------------------------------
  // Compute a Window from accumulated polls
  // -------------------------------------------------------------------------

  private computeWindow(polls: PollSnapshot[]): Window {
    const latest = polls[polls.length - 1];
    const earliest = this.prevPoll ?? polls[0];
    const durationSecs = Math.max(
      1,
      (latest.timestamp - earliest.timestamp) / 1000,
    );

    // --- Index windows (delta from previous poll to latest) ---
    const indices: Record<string, IndexWindow> = {};
    for (const idx of Object.keys(latest.perIndexQueryTotal)) {
      const prevTotal = earliest.perIndexQueryTotal[idx] ?? 0;
      const prevTime = earliest.perIndexQueryTime[idx] ?? 0;
      const currTotal = latest.perIndexQueryTotal[idx] ?? 0;
      const currTime = latest.perIndexQueryTime[idx] ?? 0;

      const deltaCount = Math.max(0, currTotal - prevTotal);
      const deltaTime = Math.max(0, currTime - prevTime);
      const avgLatency = deltaCount > 0 ? deltaTime / deltaCount : 0;

      indices[idx] = {
        queryCount: deltaCount,
        queryRate: Math.round((deltaCount / durationSecs) * 10) / 10,
        avgLatency: Math.round(avgLatency * 10) / 10,
        errorCount: 0, // would come from slow log / error log
      };
    }

    // --- Cluster snapshot (excluding system indices) ---
    let userUnassigned = 0;
    let userActive = 0;
    let worstHealth: "green" | "yellow" | "red" = "green";
    const healthRank = { green: 0, yellow: 1, red: 2 } as const;
    if (latest.clusterHealth.indices) {
      for (const [idx, ih] of Object.entries(latest.clusterHealth.indices)) {
        if (idx.startsWith(".")) continue;
        userUnassigned += ih.unassigned_shards;
        userActive += ih.active_shards;
        if (healthRank[ih.status] > healthRank[worstHealth]) {
          worstHealth = ih.status;
        }
      }
    } else {
      // Fallback if level=indices wasn't returned
      worstHealth = latest.clusterHealth.status;
      userActive = latest.clusterHealth.active_shards;
      userUnassigned = latest.clusterHealth.unassigned_shards;
    }
    const cluster: ClusterSnapshot = {
      health: worstHealth,
      nodes: latest.clusterHealth.number_of_nodes,
      activeShards: userActive,
      unassignedShards: userUnassigned,
    };

    // --- Node windows ---
    const nodes: NodeWindow[] = Object.values(latest.nodeStats.nodes).map(
      (n) => ({
        name: n.name,
        cpu: n.os?.cpu?.percent ?? 0,
        heapPercent: n.jvm?.mem?.heap_used_percent ?? 0,
        searchThreadPoolActive: n.thread_pool?.search?.active ?? 0,
        searchThreadPoolQueue: n.thread_pool?.search?.queue ?? 0,
        searchThreadPoolRejected: n.thread_pool?.search?.rejected ?? 0,
      }),
    );

    return {
      timestamp: latest.timestamp,
      duration: 30,
      indices,
      cluster,
      nodes,
    };
  }
}
