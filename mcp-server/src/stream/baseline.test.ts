import { describe, it, expect } from "vitest";
import { createBaseline, updateBaseline } from "./baseline.js";
import type { Window } from "./window.js";

function makeWindow(overrides?: {
  nodes?: number;
  indices?: Record<string, { avgLatency: number; queryRate: number }>;
}): Window {
  const indices: Window["indices"] = {};
  for (const [name, vals] of Object.entries(overrides?.indices ?? { "test-idx": { avgLatency: 10, queryRate: 100 } })) {
    indices[name] = {
      queryCount: vals.queryRate * 30,
      queryRate: vals.queryRate,
      avgLatency: vals.avgLatency,
      errorCount: 0,
    };
  }
  return {
    timestamp: Date.now(),
    duration: 30,
    indices,
    cluster: { health: "green", nodes: overrides?.nodes ?? 3, activeShards: 48, unassignedShards: 0 },
    nodes: [],
  };
}

describe("baseline", () => {
  it("starts not ready, becomes ready after 10 windows", () => {
    const bl = createBaseline();
    expect(bl.ready).toBe(false);

    for (let i = 0; i < 9; i++) {
      updateBaseline(bl, makeWindow());
    }
    expect(bl.ready).toBe(false);

    updateBaseline(bl, makeWindow());
    expect(bl.ready).toBe(true);
    expect(bl.windowCount).toBe(10);
  });

  it("averages during warmup", () => {
    const bl = createBaseline();
    // Feed 4 windows with avgLatency 10, 20, 30, 40 → average should be 25
    updateBaseline(bl, makeWindow({ indices: { "idx": { avgLatency: 10, queryRate: 100 } } }));
    updateBaseline(bl, makeWindow({ indices: { "idx": { avgLatency: 20, queryRate: 100 } } }));
    updateBaseline(bl, makeWindow({ indices: { "idx": { avgLatency: 30, queryRate: 100 } } }));
    updateBaseline(bl, makeWindow({ indices: { "idx": { avgLatency: 40, queryRate: 100 } } }));

    const idx = bl.indices.get("idx")!;
    expect(idx.avgLatency).toBe(25);
  });

  it("uses EMA after warmup (slow adaptation)", () => {
    const bl = createBaseline();
    // Warmup with 10 windows at avgLatency=10
    for (let i = 0; i < 10; i++) {
      updateBaseline(bl, makeWindow({ indices: { "idx": { avgLatency: 10, queryRate: 100 } } }));
    }
    expect(bl.ready).toBe(true);
    const before = bl.indices.get("idx")!.avgLatency;

    // Now spike to 100 — EMA should barely move (alpha=0.05)
    updateBaseline(bl, makeWindow({ indices: { "idx": { avgLatency: 100, queryRate: 100 } } }));
    const after = bl.indices.get("idx")!.avgLatency;

    // Should have moved ~5% of the gap (90 * 0.05 = 4.5)
    expect(after).toBeCloseTo(before + 0.05 * (100 - before), 1);
    expect(after).toBeLessThan(20); // still far from 100
  });

  it("tracks node count baseline", () => {
    const bl = createBaseline();
    updateBaseline(bl, makeWindow({ nodes: 3 }));
    updateBaseline(bl, makeWindow({ nodes: 3 }));
    updateBaseline(bl, makeWindow({ nodes: 3 }));
    expect(bl.nodes).toBe(3);
  });

  it("handles new indices appearing", () => {
    const bl = createBaseline();
    updateBaseline(bl, makeWindow({ indices: { "a": { avgLatency: 10, queryRate: 50 } } }));
    expect(bl.indices.has("a")).toBe(true);
    expect(bl.indices.has("b")).toBe(false);

    updateBaseline(bl, makeWindow({ indices: {
      "a": { avgLatency: 10, queryRate: 50 },
      "b": { avgLatency: 20, queryRate: 100 },
    } }));
    expect(bl.indices.has("b")).toBe(true);
    expect(bl.indices.get("b")!.avgLatency).toBe(20);
  });
});
