/**
 * EMA baseline computation.
 *
 * Tracks rolling baselines per index (avgLatency, queryRate) and
 * cluster-level (node count). Baselines start "not ready" and become
 * ready after absorbing `warmupWindows` windows (default 10 = 5 min).
 *
 * After warmup, baselines update slowly (alpha=0.05) so they adapt
 * to legitimate load changes but don't chase spikes.
 */

import type { Window } from "./window.js";

export interface IndexBaseline {
  avgLatency: number;
  queryRate: number;
}

export interface BaselineState {
  indices: Map<string, IndexBaseline>;
  nodes: number;
  ready: boolean;
  windowCount: number;
}

const WARMUP_WINDOWS = 10;
const EMA_ALPHA = 0.05;

export function createBaseline(): BaselineState {
  return {
    indices: new Map(),
    nodes: 0,
    ready: false,
    windowCount: 0,
  };
}

/**
 * Feed a new window into the baseline. During warmup, values are
 * averaged directly. After warmup, EMA with low alpha.
 */
export function updateBaseline(state: BaselineState, window: Window): void {
  state.windowCount++;

  // Node count baseline
  if (state.nodes === 0) {
    state.nodes = window.cluster.nodes;
  } else {
    state.nodes = ema(state.nodes, window.cluster.nodes, state.windowCount);
  }

  // Per-index baselines
  for (const [idx, iw] of Object.entries(window.indices)) {
    const existing = state.indices.get(idx);
    if (!existing) {
      state.indices.set(idx, {
        avgLatency: iw.avgLatency,
        queryRate: iw.queryRate,
      });
    } else {
      existing.avgLatency = ema(existing.avgLatency, iw.avgLatency, state.windowCount);
      existing.queryRate = ema(existing.queryRate, iw.queryRate, state.windowCount);
    }
  }

  if (!state.ready && state.windowCount >= WARMUP_WINDOWS) {
    state.ready = true;
  }
}

function ema(current: number, incoming: number, windowCount: number): number {
  // During warmup, use simple running average for stability.
  // After warmup, use low-alpha EMA so baseline adapts slowly.
  if (windowCount <= WARMUP_WINDOWS) {
    return current + (incoming - current) / windowCount;
  }
  return current + EMA_ALPHA * (incoming - current);
}
