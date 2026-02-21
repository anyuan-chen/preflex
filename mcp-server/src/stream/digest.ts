/**
 * Digest builder — renders Window data into a compact text summary
 * suitable for LLM consumption (~100-200 tokens).
 *
 * Two modes:
 *  - renderDigest(windows):  summarize the last N windows (default: latest 5)
 *  - renderSnapshot(window): summarize a single window
 *
 * Output is plain text, not JSON — optimized for token efficiency.
 */

import type { Window, IndexWindow, NodeWindow } from "./window.js";

// ---------------------------------------------------------------------------
// Main entry: render a digest from the last N windows
// ---------------------------------------------------------------------------

export function renderDigest(windows: Window[], count = 5): string {
  if (windows.length === 0) return "No data collected yet.";

  const recent = windows.slice(0, count); // already newest-first from RingBuffer.latest()
  const latest = recent[0];

  const lines: string[] = [];

  // --- Cluster health ---
  const c = latest.cluster;
  const healthParts = [c.health.toUpperCase(), `${c.nodes} nodes`];
  if (c.unassignedShards > 0) healthParts.push(`${c.unassignedShards} unassigned shards`);
  lines.push(healthParts.join(" | "));

  // --- Per-index stats (current window) ---
  const indexEntries = Object.entries(latest.indices)
    .filter(([, w]) => w.queryCount > 0 || w.avgLatency > 0)
    .sort((a, b) => b[1].queryRate - a[1].queryRate);

  if (indexEntries.length > 0) {
    lines.push("");
    lines.push("Indices (current window):");
    for (const [name, iw] of indexEntries.slice(0, 8)) {
      lines.push(formatIndexLine(name, iw));
    }
    if (indexEntries.length > 8) {
      lines.push(`  ... +${indexEntries.length - 8} more`);
    }
  }

  // --- Node health ---
  const hotNodes = latest.nodes.filter(
    (n) => n.heapPercent > 75 || n.cpu > 80 || n.searchThreadPoolQueue > 0,
  );
  if (hotNodes.length > 0) {
    lines.push("");
    lines.push("Hot nodes:");
    for (const n of hotNodes) {
      lines.push(formatNodeLine(n));
    }
  } else if (latest.nodes.length > 0) {
    lines.push("");
    const maxHeap = Math.max(...latest.nodes.map((n) => n.heapPercent));
    const maxCpu = Math.max(...latest.nodes.map((n) => n.cpu));
    lines.push(
      `Nodes: ${latest.nodes.length} healthy (max heap ${maxHeap}%, max cpu ${maxCpu}%)`,
    );
  }

  // --- Trends (if we have multiple windows) ---
  if (recent.length > 1) {
    const trends = computeTrends(recent);
    if (trends.length > 0) {
      lines.push("");
      lines.push(`Trend (last ${recent.length} windows, ${recent.length * 30}s):`);
      for (const t of trends) {
        lines.push(`  ${t}`);
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Single-window snapshot (for one-shot "what's happening now")
// ---------------------------------------------------------------------------

export function renderSnapshot(window: Window): string {
  return renderDigest([window], 1);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatIndexLine(name: string, iw: IndexWindow): string {
  const parts = [`${iw.queryRate} qps`];
  if (iw.avgLatency > 0) parts.push(`avg ${iw.avgLatency}ms`);
  if (iw.errorCount > 0) parts.push(`${iw.errorCount} errors`);
  return `  ${name}: ${parts.join(", ")}`;
}

function formatNodeLine(n: NodeWindow): string {
  const parts: string[] = [];
  if (n.cpu > 80) parts.push(`cpu ${n.cpu}%`);
  if (n.heapPercent > 75) parts.push(`heap ${n.heapPercent}%`);
  if (n.searchThreadPoolQueue > 0)
    parts.push(`search queue ${n.searchThreadPoolQueue}`);
  if (n.searchThreadPoolRejected > 0)
    parts.push(`rejected ${n.searchThreadPoolRejected}`);
  return `  ${n.name}: ${parts.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Trend computation — look for noteworthy changes across windows
// ---------------------------------------------------------------------------

function computeTrends(windows: Window[]): string[] {
  const trends: string[] = [];

  // Cluster-wide qps trend (sum of all index queryRates)
  const qpsOverTime = windows.map((w) =>
    Object.values(w.indices).reduce((sum, iw) => sum + iw.queryRate, 0),
  );
  const qpsTrend = formatTrendLine("total qps", qpsOverTime, "");
  if (qpsTrend) trends.push(qpsTrend);

  // Per-index avg latency trends
  const latestIndices = Object.keys(windows[0].indices);
  for (const idx of latestIndices) {
    const avgs = windows.map((w) => w.indices[idx]?.avgLatency ?? 0);
    if (avgs.some((v) => v > 20)) {
      const avgTrend = formatTrendLine(`${idx} avg`, avgs, "ms");
      if (avgTrend) trends.push(avgTrend);
    }
  }

  // Cluster health changes
  const healthChanges = windows.map((w) => w.cluster.health);
  if (new Set(healthChanges).size > 1) {
    trends.push(
      `health: ${healthChanges.reverse().join(" → ")}`,
    );
  }

  return trends;
}

function formatTrendLine(
  label: string,
  values: number[],
  unit: string,
): string | null {
  if (values.length < 2) return null;
  // values are newest-first; reverse to show chronological
  const chrono = [...values].reverse();
  const first = chrono[0];
  const last = chrono[chrono.length - 1];
  if (first === 0 && last === 0) return null;

  const suffix = unit ? unit : "";
  const formatted = chrono.map((v) => `${Math.round(v)}${suffix}`).join(" → ");
  const pctChange =
    first > 0 ? Math.round(((last - first) / first) * 100) : 0;

  if (Math.abs(pctChange) < 10) return null; // not noteworthy

  const direction = pctChange > 0 ? "+" : "";
  return `${label}: ${formatted} (${direction}${pctChange}%)`;
}
