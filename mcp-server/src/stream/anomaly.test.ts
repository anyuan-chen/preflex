import { describe, it, expect } from "vitest";
import { AnomalyDetector, anomalyKey, type DetectionContext } from "./anomaly.js";
import { createBaseline, updateBaseline, type BaselineState } from "./baseline.js";
import type { Window, NodeWindow } from "./window.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWindow(overrides?: {
  health?: "green" | "yellow" | "red";
  nodes?: number;
  unassigned?: number;
  indices?: Record<string, { avgLatency?: number; queryRate?: number; queryCount?: number }>;
  nodeWindows?: Array<Partial<NodeWindow> & { name: string }>;
}): Window {
  const indices: Window["indices"] = {};
  for (const [name, vals] of Object.entries(overrides?.indices ?? {})) {
    indices[name] = {
      queryCount: vals.queryCount ?? Math.round((vals.queryRate ?? 100) * 30),
      queryRate: vals.queryRate ?? 100,
      avgLatency: vals.avgLatency ?? 10,
      errorCount: 0,
    };
  }
  return {
    timestamp: Date.now(),
    duration: 30,
    indices,
    cluster: {
      health: overrides?.health ?? "green",
      nodes: overrides?.nodes ?? 3,
      activeShards: 48,
      unassignedShards: overrides?.unassigned ?? 0,
    },
    nodes: (overrides?.nodeWindows ?? []).map((n) => ({
      name: n.name,
      cpu: n.cpu ?? 30,
      heapPercent: n.heapPercent ?? 50,
      searchThreadPoolActive: n.searchThreadPoolActive ?? 2,
      searchThreadPoolQueue: n.searchThreadPoolQueue ?? 0,
      searchThreadPoolRejected: n.searchThreadPoolRejected ?? 0,
    })),
  };
}

function readyBaseline(overrides?: {
  indices?: Record<string, { avgLatency: number; queryRate: number }>;
  nodes?: number;
}): BaselineState {
  const bl = createBaseline();
  const indices = overrides?.indices ?? { "test-idx": { avgLatency: 10, queryRate: 100 } };
  for (let i = 0; i < 10; i++) {
    const idxWindows: Record<string, { avgLatency: number; queryRate: number }> = {};
    for (const [name, vals] of Object.entries(indices)) {
      idxWindows[name] = vals;
    }
    const win = makeWindow({
      nodes: overrides?.nodes ?? 3,
      indices: idxWindows,
    });
    updateBaseline(bl, win);
  }
  return bl;
}

function ctx(current: Window, recent: Window[], baseline: BaselineState): DetectionContext {
  return { current, recent, baseline };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnomalyDetector", () => {
  const detector = new AnomalyDetector();

  describe("cluster_red", () => {
    it("fires critical on red health", () => {
      const win = makeWindow({ health: "red", unassigned: 10 });
      const bl = createBaseline();
      const anomalies = detector.detect(ctx(win, [win], bl));

      const red = anomalies.find((a) => a.rule === "cluster_red");
      expect(red).toBeDefined();
      expect(red!.severity).toBe("critical");
      expect(red!.description).toContain("RED");
    });

    it("does not fire on green", () => {
      const win = makeWindow({ health: "green" });
      const anomalies = detector.detect(ctx(win, [win], createBaseline()));
      expect(anomalies.find((a) => a.rule === "cluster_red")).toBeUndefined();
    });
  });

  describe("cluster_yellow", () => {
    it("fires on transition from green to yellow", () => {
      const prev = makeWindow({ health: "green" });
      const curr = makeWindow({ health: "yellow", unassigned: 2 });
      const anomalies = detector.detect(ctx(curr, [curr, prev], createBaseline()));

      const yellow = anomalies.find((a) => a.rule === "cluster_yellow");
      expect(yellow).toBeDefined();
      expect(yellow!.severity).toBe("warning");
    });

    it("does not fire if already yellow", () => {
      const prev = makeWindow({ health: "yellow", unassigned: 2 });
      const curr = makeWindow({ health: "yellow", unassigned: 2 });
      const anomalies = detector.detect(ctx(curr, [curr, prev], createBaseline()));
      expect(anomalies.find((a) => a.rule === "cluster_yellow")).toBeUndefined();
    });

    it("fires if only one window (no previous)", () => {
      const curr = makeWindow({ health: "yellow", unassigned: 2 });
      const anomalies = detector.detect(ctx(curr, [curr], createBaseline()));
      expect(anomalies.find((a) => a.rule === "cluster_yellow")).toBeDefined();
    });
  });

  describe("node_drop", () => {
    it("fires critical when nodes decrease", () => {
      const bl = readyBaseline({ nodes: 3 });
      const win = makeWindow({ nodes: 2 });
      const anomalies = detector.detect(ctx(win, [win], bl));

      const drop = anomalies.find((a) => a.rule === "node_drop");
      expect(drop).toBeDefined();
      expect(drop!.severity).toBe("critical");
      expect(drop!.description).toContain("2");
      expect(drop!.description).toContain("3");
    });

    it("does not fire during warmup", () => {
      const bl = createBaseline(); // not ready
      const win = makeWindow({ nodes: 1 });
      const anomalies = detector.detect(ctx(win, [win], bl));
      expect(anomalies.find((a) => a.rule === "node_drop")).toBeUndefined();
    });

    it("does not fire when count matches baseline", () => {
      const bl = readyBaseline({ nodes: 3 });
      const win = makeWindow({ nodes: 3 });
      const anomalies = detector.detect(ctx(win, [win], bl));
      expect(anomalies.find((a) => a.rule === "node_drop")).toBeUndefined();
    });
  });

  describe("heap_pressure", () => {
    it("fires when heap > 85% sustained over 2 windows", () => {
      const node = { name: "hot-node", heapPercent: 88 };
      const prev = makeWindow({ nodeWindows: [node] });
      const curr = makeWindow({ nodeWindows: [node] });
      const anomalies = detector.detect(ctx(curr, [curr, prev], createBaseline()));

      const heap = anomalies.find((a) => a.rule === "heap_pressure");
      expect(heap).toBeDefined();
      expect(heap!.severity).toBe("warning");
      expect(heap!.node).toBe("hot-node");
    });

    it("fires critical when heap > 92%", () => {
      const node = { name: "hot-node", heapPercent: 95 };
      const prev = makeWindow({ nodeWindows: [node] });
      const curr = makeWindow({ nodeWindows: [node] });
      const anomalies = detector.detect(ctx(curr, [curr, prev], createBaseline()));

      const heap = anomalies.find((a) => a.rule === "heap_pressure");
      expect(heap!.severity).toBe("critical");
    });

    it("does not fire on single-window spike", () => {
      const normal = { name: "node", heapPercent: 60 };
      const hot = { name: "node", heapPercent: 90 };
      const prev = makeWindow({ nodeWindows: [normal] });
      const curr = makeWindow({ nodeWindows: [hot] });
      const anomalies = detector.detect(ctx(curr, [curr, prev], createBaseline()));
      expect(anomalies.find((a) => a.rule === "heap_pressure")).toBeUndefined();
    });
  });

  describe("thread_pool_saturation", () => {
    it("fires when queue > 0 sustained", () => {
      const node = { name: "busy-node", searchThreadPoolQueue: 5 };
      const prev = makeWindow({ nodeWindows: [node] });
      const curr = makeWindow({ nodeWindows: [node] });
      const anomalies = detector.detect(ctx(curr, [curr, prev], createBaseline()));

      const tp = anomalies.find((a) => a.rule === "thread_pool_saturation" && a.description.includes("queue"));
      expect(tp).toBeDefined();
      expect(tp!.severity).toBe("warning");
    });

    it("fires critical on rejections (immediate, no sustained check)", () => {
      const node = { name: "bad-node", searchThreadPoolRejected: 3 };
      const curr = makeWindow({ nodeWindows: [node] });
      const anomalies = detector.detect(ctx(curr, [curr], createBaseline()));

      const tp = anomalies.find((a) => a.description.includes("rejections"));
      expect(tp).toBeDefined();
      expect(tp!.severity).toBe("critical");
    });
  });

  describe("latency_spike", () => {
    it("fires warning when avg > 2x baseline", () => {
      const bl = readyBaseline({ indices: { "idx": { avgLatency: 10, queryRate: 100 } } });
      const win = makeWindow({ indices: { "idx": { avgLatency: 25 } } });
      const anomalies = detector.detect(ctx(win, [win], bl));

      const spike = anomalies.find((a) => a.rule === "latency_spike");
      expect(spike).toBeDefined();
      expect(spike!.severity).toBe("warning");
      expect(spike!.index).toBe("idx");
      expect(spike!.description).toContain("2.5x");
    });

    it("fires critical when avg > 4x baseline", () => {
      const bl = readyBaseline({ indices: { "idx": { avgLatency: 10, queryRate: 100 } } });
      const win = makeWindow({ indices: { "idx": { avgLatency: 50 } } });
      const anomalies = detector.detect(ctx(win, [win], bl));

      const spike = anomalies.find((a) => a.rule === "latency_spike");
      expect(spike!.severity).toBe("critical");
    });

    it("does not fire when latency is near baseline", () => {
      const bl = readyBaseline({ indices: { "idx": { avgLatency: 10, queryRate: 100 } } });
      const win = makeWindow({ indices: { "idx": { avgLatency: 12 } } });
      const anomalies = detector.detect(ctx(win, [win], bl));
      expect(anomalies.find((a) => a.rule === "latency_spike")).toBeUndefined();
    });

    it("does not fire on idle index", () => {
      const bl = readyBaseline({ indices: { "idx": { avgLatency: 10, queryRate: 100 } } });
      const win = makeWindow({ indices: { "idx": { avgLatency: 50, queryCount: 0, queryRate: 0 } } });
      const anomalies = detector.detect(ctx(win, [win], bl));
      expect(anomalies.find((a) => a.rule === "latency_spike")).toBeUndefined();
    });

    it("does not fire during warmup", () => {
      const bl = createBaseline();
      const win = makeWindow({ indices: { "idx": { avgLatency: 999 } } });
      const anomalies = detector.detect(ctx(win, [win], bl));
      expect(anomalies.find((a) => a.rule === "latency_spike")).toBeUndefined();
    });
  });

  describe("query_rate_spike", () => {
    it("fires when qps > 3x baseline", () => {
      const bl = readyBaseline({ indices: { "idx": { avgLatency: 10, queryRate: 100 } } });
      const win = makeWindow({ indices: { "idx": { queryRate: 350 } } });
      const anomalies = detector.detect(ctx(win, [win], bl));

      const spike = anomalies.find((a) => a.rule === "query_rate_spike");
      expect(spike).toBeDefined();
      expect(spike!.index).toBe("idx");
      expect(spike!.description).toContain("3.5x");
    });

    it("does not fire at 2x baseline", () => {
      const bl = readyBaseline({ indices: { "idx": { avgLatency: 10, queryRate: 100 } } });
      const win = makeWindow({ indices: { "idx": { queryRate: 200 } } });
      const anomalies = detector.detect(ctx(win, [win], bl));
      expect(anomalies.find((a) => a.rule === "query_rate_spike")).toBeUndefined();
    });

    it("skips near-zero baseline indices", () => {
      const bl = readyBaseline({ indices: { "idle": { avgLatency: 0, queryRate: 0.5 } } });
      const win = makeWindow({ indices: { "idle": { queryRate: 5 } } });
      const anomalies = detector.detect(ctx(win, [win], bl));
      expect(anomalies.find((a) => a.rule === "query_rate_spike")).toBeUndefined();
    });
  });

  describe("stateless — fires every time", () => {
    it("detects the same anomaly on repeated calls", () => {
      const bl = readyBaseline({ indices: { "idx": { avgLatency: 10, queryRate: 100 } } });
      const win = makeWindow({ indices: { "idx": { avgLatency: 50 } } });
      const context = ctx(win, [win], bl);

      const first = detector.detect(context);
      expect(first.find((a) => a.rule === "latency_spike")).toBeDefined();

      // No cooldown — fires again
      const second = detector.detect(context);
      expect(second.find((a) => a.rule === "latency_spike")).toBeDefined();
    });
  });

  describe("anomalyKey", () => {
    it("includes rule, index, and node", () => {
      expect(anomalyKey({ rule: "latency_spike", severity: "warning", description: "x", index: "idx" }))
        .toBe("latency_spike:idx:");
      expect(anomalyKey({ rule: "heap_pressure", severity: "critical", description: "x", node: "n1" }))
        .toBe("heap_pressure::n1");
      expect(anomalyKey({ rule: "cluster_red", severity: "critical", description: "x" }))
        .toBe("cluster_red::");
    });
  });

  describe("multiple anomalies in one check", () => {
    it("detects multiple issues simultaneously", () => {
      const bl = readyBaseline({
        indices: { "idx": { avgLatency: 10, queryRate: 100 } },
        nodes: 3,
      });
      const win = makeWindow({
        health: "red",
        nodes: 2,
        unassigned: 5,
        indices: { "idx": { avgLatency: 50 } },
        nodeWindows: [{ name: "n1", heapPercent: 95 }, { name: "n1", heapPercent: 95 }],
      });
      const prev = makeWindow({
        nodeWindows: [{ name: "n1", heapPercent: 95 }],
      });

      const anomalies = detector.detect(ctx(win, [win, prev], bl));
      const rules = anomalies.map((a) => a.rule);

      expect(rules).toContain("cluster_red");
      expect(rules).toContain("node_drop");
      expect(rules).toContain("latency_spike");
    });
  });
});
