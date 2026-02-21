import { describe, it, expect } from "vitest";
import { renderDigest, renderSnapshot } from "./digest.js";
import type { Window } from "./window.js";

// ---------------------------------------------------------------------------
// Helpers — build Windows for testing
// ---------------------------------------------------------------------------

function makeWindow(overrides?: {
  timestamp?: number;
  health?: "green" | "yellow" | "red";
  unassigned?: number;
  indices?: Record<string, {
    queryRate?: number;
    avgLatency?: number;
    errorCount?: number;
  }>;
  nodes?: Array<{
    name?: string;
    cpu?: number;
    heapPercent?: number;
    searchQueue?: number;
  }>;
}): Window {
  const indices: Window["indices"] = {};
  if (overrides?.indices) {
    for (const [name, iw] of Object.entries(overrides.indices)) {
      indices[name] = {
        queryCount: Math.round((iw.queryRate ?? 100) * 30),
        queryRate: iw.queryRate ?? 100,
        avgLatency: iw.avgLatency ?? 15,
        errorCount: iw.errorCount ?? 0,
      };
    }
  } else {
    indices["metrics-2024.01"] = {
      queryCount: 3000,
      queryRate: 100,
      avgLatency: 15,
      errorCount: 0,
    };
    indices["logs-2024.01"] = {
      queryCount: 6000,
      queryRate: 200,
      avgLatency: 8,
      errorCount: 0,
    };
  }

  return {
    timestamp: overrides?.timestamp ?? 1706140800000, // 2024-01-25T00:00:00Z
    duration: 30,
    indices,
    cluster: {
      health: overrides?.health ?? "green",
      nodes: 3,
      activeShards: 48,
      unassignedShards: overrides?.unassigned ?? 0,
    },
    nodes: (overrides?.nodes ?? [{ name: "es-node-01" }]).map((n) => ({
      name: n.name ?? "es-node-01",
      cpu: n.cpu ?? 35,
      heapPercent: n.heapPercent ?? 60,
      searchThreadPoolActive: 2,
      searchThreadPoolQueue: n.searchQueue ?? 0,
      searchThreadPoolRejected: 0,
    })),
  };
}

describe("renderSnapshot", () => {
  it("renders a single window into compact text", () => {
    const win = makeWindow();
    const text = renderSnapshot(win);

    expect(text).toContain("GREEN");
    expect(text).toContain("3 nodes");
    expect(text).not.toContain("active shards"); // removed — not actionable alone
    expect(text).toContain("logs-2024.01");
    expect(text).toContain("200 qps");
    expect(text).toContain("metrics-2024.01");
    expect(text).toContain("100 qps");
  });

  it("does not show timestamp or window duration", () => {
    const text = renderSnapshot(makeWindow());
    expect(text).not.toContain("window=");
    expect(text).not.toMatch(/\d{2}:\d{2}:\d{2}Z/);
  });

  it("shows unassigned shards for yellow health", () => {
    const text = renderSnapshot(makeWindow({ health: "yellow", unassigned: 5 }));
    expect(text).toContain("YELLOW");
    expect(text).toContain("5 unassigned");
  });

  it("shows hot nodes when heap or cpu is high", () => {
    const text = renderSnapshot(
      makeWindow({
        nodes: [
          { name: "hot-node", cpu: 92, heapPercent: 88, searchQueue: 3 },
        ],
      }),
    );
    expect(text).toContain("Hot nodes:");
    expect(text).toContain("hot-node");
    expect(text).toContain("cpu 92%");
    expect(text).toContain("heap 88%");
    expect(text).toContain("search queue 3");
  });

  it("shows healthy summary when no hot nodes", () => {
    const text = renderSnapshot(
      makeWindow({ nodes: [{ name: "ok-node", cpu: 20, heapPercent: 40 }] }),
    );
    expect(text).not.toContain("Hot nodes:");
    expect(text).toContain("healthy");
  });

  it("shows error counts when present", () => {
    const text = renderSnapshot(
      makeWindow({
        indices: { "bad-idx": { queryRate: 50, avgLatency: 100, errorCount: 12 } },
      }),
    );
    expect(text).toContain("12 errors");
  });

  it("omits indices with zero activity", () => {
    const text = renderSnapshot(
      makeWindow({
        indices: {
          "active-idx": { queryRate: 100 },
          "idle-idx": { queryRate: 0, avgLatency: 0 },
        },
      }),
    );
    expect(text).toContain("active-idx");
    expect(text).not.toContain("idle-idx");
  });

  it("does not contain p99", () => {
    const text = renderSnapshot(makeWindow());
    expect(text).not.toContain("p99");
  });
});

describe("renderDigest (multi-window trends)", () => {
  it("renders trends across multiple windows", () => {
    const windows = [
      makeWindow({
        timestamp: 1706140890000,
        indices: { "test-idx": { queryRate: 300, avgLatency: 80 } },
      }),
      makeWindow({
        timestamp: 1706140860000,
        indices: { "test-idx": { queryRate: 200, avgLatency: 50 } },
      }),
      makeWindow({
        timestamp: 1706140830000,
        indices: { "test-idx": { queryRate: 100, avgLatency: 25 } },
      }),
    ];

    const text = renderDigest(windows);
    expect(text).toContain("Trend");
    expect(text).toContain("last 3 windows");
  });

  it("shows avg latency trend with ms unit", () => {
    const windows = [
      makeWindow({
        timestamp: 3,
        indices: { "slow-idx": { queryRate: 100, avgLatency: 120 } },
      }),
      makeWindow({
        timestamp: 2,
        indices: { "slow-idx": { queryRate: 100, avgLatency: 60 } },
      }),
      makeWindow({
        timestamp: 1,
        indices: { "slow-idx": { queryRate: 100, avgLatency: 30 } },
      }),
    ];

    const text = renderDigest(windows);
    expect(text).toContain("slow-idx avg");
    expect(text).toContain("ms");
  });

  it("shows health transitions", () => {
    const windows = [
      makeWindow({ timestamp: 3, health: "red" }),
      makeWindow({ timestamp: 2, health: "yellow" }),
      makeWindow({ timestamp: 1, health: "green" }),
    ];

    const text = renderDigest(windows);
    expect(text).toContain("health:");
    expect(text).toContain("green");
    expect(text).toContain("red");
  });

  it("returns message for empty windows", () => {
    expect(renderDigest([])).toBe("No data collected yet.");
  });

  it("limits to count parameter", () => {
    const windows = Array.from({ length: 10 }, (_, i) =>
      makeWindow({
        timestamp: 1706140800000 + (9 - i) * 30000,
        indices: {
          "test-idx": { queryRate: 100 + i * 50, avgLatency: 20 + i * 15 },
        },
      }),
    );

    const text = renderDigest(windows, 3);
    expect(text).toContain("last 3 windows");
    expect(text).toContain("90s");
  });

  it("stays under ~200 tokens for typical cluster", () => {
    const windows = Array.from({ length: 5 }, (_, i) =>
      makeWindow({
        timestamp: 1706140800000 + i * 30000,
        indices: {
          "metrics-2024.01": { queryRate: 340 + i * 50, avgLatency: 30 + i * 10 },
          "logs-2024.01": { queryRate: 200, avgLatency: 8 },
          "events": { queryRate: 50, avgLatency: 5 },
        },
        nodes: [
          { name: "es-node-01", cpu: 35, heapPercent: 60 },
          { name: "es-node-02", cpu: 40, heapPercent: 55 },
          { name: "es-node-03", cpu: 30, heapPercent: 50 },
        ],
      }),
    );

    const text = renderDigest(windows);
    const estimatedTokens = text.split(/\s+/).length * 0.75;
    expect(estimatedTokens).toBeLessThan(250);
    expect(text.length).toBeGreaterThan(50);
  });

  it("sorts indices by query rate (highest first)", () => {
    const text = renderSnapshot(
      makeWindow({
        indices: {
          "slow-idx": { queryRate: 50 },
          "hot-idx": { queryRate: 500 },
          "mid-idx": { queryRate: 150 },
        },
      }),
    );

    const hotPos = text.indexOf("hot-idx");
    const midPos = text.indexOf("mid-idx");
    const slowPos = text.indexOf("slow-idx");
    expect(hotPos).toBeLessThan(midPos);
    expect(midPos).toBeLessThan(slowPos);
  });
});

describe("digest output format", () => {
  it("produces clean, readable text (visual check)", () => {
    const windows = [
      makeWindow({
        timestamp: 1706140890000,
        health: "yellow",
        unassigned: 2,
        indices: {
          "metrics-*": { queryRate: 340, avgLatency: 35, errorCount: 0 },
          "logs-2024.01": { queryRate: 200, avgLatency: 8, errorCount: 0 },
          "events": { queryRate: 50, avgLatency: 5, errorCount: 3 },
        },
        nodes: [
          { name: "es-node-01", cpu: 35, heapPercent: 87, searchQueue: 2 },
          { name: "es-node-02", cpu: 40, heapPercent: 55 },
          { name: "es-node-03", cpu: 30, heapPercent: 50 },
        ],
      }),
      makeWindow({
        timestamp: 1706140860000,
        indices: {
          "metrics-*": { queryRate: 300, avgLatency: 25 },
          "logs-2024.01": { queryRate: 200, avgLatency: 8 },
          "events": { queryRate: 50, avgLatency: 5 },
        },
      }),
      makeWindow({
        timestamp: 1706140830000,
        indices: {
          "metrics-*": { queryRate: 250, avgLatency: 15 },
          "logs-2024.01": { queryRate: 200, avgLatency: 8 },
          "events": { queryRate: 50, avgLatency: 5 },
        },
      }),
    ];

    const text = renderDigest(windows);

    expect(text).toContain("YELLOW");
    expect(text).toContain("2 unassigned");
    expect(text).toContain("Hot nodes:");
    expect(text).toContain("es-node-01");
    expect(text).toContain("heap 87%");
    expect(text).toContain("metrics-*");
    expect(text).toContain("35ms"); // avg latency
    expect(text).toContain("Trend");
    expect(text).not.toContain("p99");
  });
});
