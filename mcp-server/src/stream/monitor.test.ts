import { describe, it, expect, vi, beforeEach } from "vitest";
import { Monitor, type MonitorEvent } from "./monitor.js";
import type { Window } from "./window.js";

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockPoll = vi.fn<() => Promise<Window | null>>();
const mockLatest = vi.fn().mockReturnValue([]);
vi.mock("./processor.js", () => {
  return {
    StreamProcessor: class MockStreamProcessor {
      windows = { latest: mockLatest, push: vi.fn(), length: 0, capacity: 30, clear: vi.fn() };
      poll = mockPoll;
    },
  };
});

const mockInvokeAgent = vi.fn();
vi.mock("./invoke.js", () => ({
  invokeAgent: (...args: unknown[]) => mockInvokeAgent(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWindow(overrides?: {
  health?: "green" | "yellow" | "red";
  nodes?: number;
  unassigned?: number;
  indices?: Record<string, { avgLatency?: number; queryRate?: number; queryCount?: number }>;
}): Window {
  const indices: Window["indices"] = {};
  for (const [name, vals] of Object.entries(overrides?.indices ?? { "test-idx": {} })) {
    indices[name] = {
      queryCount: vals.queryCount ?? 3000,
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
    nodes: [],
  };
}

/** Flush microtask queue so fire-and-forget promises resolve. */
const flush = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Monitor", () => {
  let monitor: Monitor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLatest.mockReturnValue([]);
    monitor = new Monitor(30, 0); // 0ms cooldown for tests
  });

  describe("tick — no window", () => {
    it("does nothing when poll returns null", async () => {
      mockPoll.mockResolvedValueOnce(null);
      const events: MonitorEvent[] = [];
      monitor.on((e) => events.push(e));

      await monitor.tick();

      expect(events).toHaveLength(0);
    });
  });

  describe("tick — window with no anomalies", () => {
    it("emits a window event only", async () => {
      const win = makeWindow();
      mockPoll.mockResolvedValueOnce(win);
      mockLatest.mockReturnValue([win]);

      const events: MonitorEvent[] = [];
      monitor.on((e) => events.push(e));

      await monitor.tick();

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("window");
      expect(events[0].window).toBe(win);
    });
  });

  describe("tick — window with anomalies", () => {
    it("emits window + anomaly events, then invocation after agent completes", async () => {
      const win = makeWindow({ health: "red", unassigned: 5 });
      mockPoll.mockResolvedValueOnce(win);
      mockLatest.mockReturnValue([win]);
      mockInvokeAgent.mockResolvedValueOnce({
        success: true,
        conversationId: "conv-1",
        agentResponse: "Investigating...",
      });

      const events: MonitorEvent[] = [];
      monitor.on((e) => events.push(e));

      await monitor.tick();

      // tick() returns immediately — window + anomaly events are synchronous
      expect(events.filter((e) => e.type === "window")).toHaveLength(1);
      expect(events.filter((e) => e.type === "anomaly")).toHaveLength(1);

      // Invocation event comes after the fire-and-forget promise resolves
      await flush();

      const invocationEvent = events.find((e) => e.type === "invocation");
      expect(invocationEvent).toBeDefined();
      expect(invocationEvent!.invocationResult!.success).toBe(true);
    });

    it("passes anomalies and recent windows to invokeAgent", async () => {
      const win = makeWindow({ health: "red", unassigned: 5 });
      mockPoll.mockResolvedValueOnce(win);
      mockLatest.mockReturnValue([win]);
      mockInvokeAgent.mockResolvedValueOnce({ success: true });

      await monitor.tick();
      await flush();

      expect(mockInvokeAgent).toHaveBeenCalledOnce();
      const [anomalies, recent] = mockInvokeAgent.mock.calls[0];
      expect(anomalies.length).toBeGreaterThan(0);
      expect(recent).toEqual([win]);
    });
  });

  describe("locking", () => {
    it("locks anomaly keys while agent is running", async () => {
      const win = makeWindow({ health: "red", unassigned: 5 });
      mockPoll.mockResolvedValueOnce(win);
      mockLatest.mockReturnValue([win]);

      // Agent hangs indefinitely
      let resolveAgent!: (v: any) => void;
      mockInvokeAgent.mockReturnValueOnce(new Promise((r) => { resolveAgent = r; }));

      await monitor.tick();

      // Lock should be active (Infinity = in-flight)
      expect(monitor.activeLocks.get("cluster_red::")).toBe(Infinity);

      // Resolve the agent — lock transitions to cooldown
      resolveAgent({ success: true });
      await flush();

      // With 0ms cooldown, lock expires immediately
      const until = monitor.activeLocks.get("cluster_red::");
      expect(until).toBeDefined();
      expect(until).not.toBe(Infinity); // no longer in-flight
      expect(Date.now() >= until!).toBe(true); // cooldown expired
    });

    it("skips invocation for locked anomaly keys", async () => {
      const win = makeWindow({ health: "red", unassigned: 5 });
      mockLatest.mockReturnValue([win]);

      // First tick — agent hangs
      let resolveFirst!: (v: any) => void;
      mockInvokeAgent.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }));
      mockPoll.mockResolvedValueOnce(win);
      await monitor.tick();

      expect(mockInvokeAgent).toHaveBeenCalledTimes(1);
      expect(monitor.activeLocks.get("cluster_red::")).toBe(Infinity);

      // Second tick — same anomaly, should be locked (in-flight)
      mockPoll.mockResolvedValueOnce(makeWindow({ health: "red", unassigned: 5 }));
      await monitor.tick();

      // Should NOT have invoked again
      expect(mockInvokeAgent).toHaveBeenCalledTimes(1);

      // Cleanup
      resolveFirst({ success: true });
      await flush();
    });

    it("allows concurrent invocations for different anomaly keys", async () => {
      // First tick: cluster_red
      const redWin = makeWindow({ health: "red", unassigned: 5 });
      mockPoll.mockResolvedValueOnce(redWin);
      mockLatest.mockReturnValue([redWin]);

      let resolveFirst!: (v: any) => void;
      mockInvokeAgent.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }));
      await monitor.tick();

      expect(mockInvokeAgent).toHaveBeenCalledTimes(1);
      expect(monitor.activeLocks.has("cluster_red::")).toBe(true);

      // Second tick: still red (locked) BUT also node_drop (new, unlocked)
      // We need baseline ready for node_drop to fire
      // Feed 10 windows into baseline to make it ready
      for (let i = 0; i < 10; i++) {
        const greenWin = makeWindow({ nodes: 3 });
        mockPoll.mockResolvedValueOnce(greenWin);
        mockLatest.mockReturnValue([greenWin]);
        await monitor.tick();
      }

      // Now a window with red + node drop
      const redDropWin = makeWindow({ health: "red", unassigned: 5, nodes: 1 });
      mockPoll.mockResolvedValueOnce(redDropWin);
      mockLatest.mockReturnValue([redDropWin]);

      let resolveSecond!: (v: any) => void;
      mockInvokeAgent.mockReturnValueOnce(new Promise((r) => { resolveSecond = r; }));
      await monitor.tick();

      // Should have invoked again for node_drop (cluster_red is locked)
      // Call count: 1 (first red) + 10 (green windows, no anomalies) + 1 (node_drop) = 2
      // Wait — green windows have no anomalies, so no invocations for those
      expect(mockInvokeAgent).toHaveBeenCalledTimes(2);

      // Both locks active (in-flight)
      expect(monitor.activeLocks.get("cluster_red::")).toBe(Infinity);
      expect(monitor.activeLocks.get("node_drop::")).toBe(Infinity);

      // Cleanup
      resolveFirst({ success: true });
      resolveSecond({ success: true });
      await flush();
    });

    it("respects cooldown period before re-invoking", async () => {
      // Use 60s cooldown
      const cooldownMonitor = new Monitor(30, 60_000);
      const win = makeWindow({ health: "red", unassigned: 5 });
      mockPoll.mockResolvedValueOnce(win);
      mockLatest.mockReturnValue([win]);
      mockInvokeAgent.mockResolvedValueOnce({ success: true });

      await cooldownMonitor.tick();
      await flush();

      expect(mockInvokeAgent).toHaveBeenCalledTimes(1);

      // Second tick — same anomaly, should be in cooldown
      mockPoll.mockResolvedValueOnce(makeWindow({ health: "red", unassigned: 5 }));
      await cooldownMonitor.tick();

      // Should NOT re-invoke — still in cooldown
      expect(mockInvokeAgent).toHaveBeenCalledTimes(1);
    });

    it("releases locks even on agent error", async () => {
      const win = makeWindow({ health: "red", unassigned: 5 });
      mockPoll.mockResolvedValueOnce(win);
      mockLatest.mockReturnValue([win]);
      mockInvokeAgent.mockRejectedValueOnce(new Error("Agent crashed"));

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await monitor.tick();
      await flush();

      // Lock should transition to cooldown (not in-flight)
      const until = monitor.activeLocks.get("cluster_red::");
      expect(until).toBeDefined();
      expect(until).not.toBe(Infinity);

      consoleSpy.mockRestore();
    });
  });

  describe("event listener management", () => {
    it("on() returns unsubscribe function", async () => {
      mockPoll.mockResolvedValue(makeWindow());
      mockLatest.mockReturnValue([makeWindow()]);

      const events: MonitorEvent[] = [];
      const unsub = monitor.on((e) => events.push(e));

      await monitor.tick();
      expect(events).toHaveLength(1);

      unsub();

      await monitor.tick();
      expect(events).toHaveLength(1); // no new events after unsub
    });

    it("listener errors don't break the monitor", async () => {
      const win = makeWindow();
      mockPoll.mockResolvedValueOnce(win);
      mockLatest.mockReturnValue([win]);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      monitor.on(() => { throw new Error("listener broke"); });

      const goodEvents: MonitorEvent[] = [];
      monitor.on((e) => goodEvents.push(e));

      await monitor.tick();

      expect(goodEvents).toHaveLength(1);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe("start/stop", () => {
    it("start() calls tick immediately", async () => {
      mockPoll.mockResolvedValue(null);

      vi.useFakeTimers();
      monitor.start(10_000);
      await vi.advanceTimersByTimeAsync(0);

      monitor.stop();
      vi.useRealTimers();

      expect(mockPoll).toHaveBeenCalled();
    });

    it("start() is idempotent", () => {
      mockPoll.mockResolvedValue(null);

      vi.useFakeTimers();
      monitor.start(10_000);
      monitor.start(10_000);
      monitor.stop();
      vi.useRealTimers();
    });

    it("stop() clears the interval", () => {
      mockPoll.mockResolvedValue(null);

      vi.useFakeTimers();
      monitor.start(10_000);
      monitor.stop();

      const callCount = mockPoll.mock.calls.length;
      vi.advanceTimersByTime(30_000);
      expect(mockPoll.mock.calls.length).toBe(callCount);

      vi.useRealTimers();
    });
  });

  describe("error handling", () => {
    it("tick() catches and logs poll errors", async () => {
      mockPoll.mockRejectedValueOnce(new Error("ES unreachable"));

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await monitor.tick();

      expect(consoleSpy).toHaveBeenCalledWith(
        "Monitor tick error:",
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });
  });
});
