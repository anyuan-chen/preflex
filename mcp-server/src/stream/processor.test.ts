import { describe, it, expect, vi, beforeEach } from "vitest";

const mockEsFetch = vi.fn();
vi.mock("../es-client.js", () => ({
  esFetch: (...args: unknown[]) => mockEsFetch(...args),
}));

const { StreamProcessor } = await import("./processor.js");

// ---------------------------------------------------------------------------
// Helpers — build mock ES responses
// ---------------------------------------------------------------------------

function makeNodeStats(overrides?: {
  heap?: number;
  cpu?: number;
  searchQueue?: number;
}) {
  return {
    nodes: {
      node1: {
        name: "es-node-01",
        os: { cpu: { percent: overrides?.cpu ?? 35 } },
        jvm: { mem: { heap_used_percent: overrides?.heap ?? 60 } },
        thread_pool: {
          search: {
            active: 2,
            queue: overrides?.searchQueue ?? 0,
            rejected: 0,
          },
        },
      },
    },
  };
}

function makeClusterHealth(status: "green" | "yellow" | "red" = "green") {
  return {
    status,
    number_of_nodes: 3,
    active_shards: 48,
    unassigned_shards: status === "green" ? 0 : 2,
  };
}

function makeIndexStats(
  indices: Record<string, { queryTotal: number; queryTime: number }>,
) {
  const result: Record<string, unknown> = {};
  for (const [idx, stats] of Object.entries(indices)) {
    result[idx] = {
      total: {
        search: {
          query_total: stats.queryTotal,
          query_time_in_millis: stats.queryTime,
        },
      },
    };
  }
  return { indices: result };
}

function setupMocks(opts?: {
  health?: "green" | "yellow" | "red";
  heap?: number;
  cpu?: number;
  searchQueue?: number;
  indices?: Record<string, { queryTotal: number; queryTime: number }>;
}) {
  mockEsFetch.mockImplementation((_method: string, path: string) => {
    if (path.includes("_nodes/stats"))
      return Promise.resolve(
        makeNodeStats({
          heap: opts?.heap,
          cpu: opts?.cpu,
          searchQueue: opts?.searchQueue,
        }),
      );
    if (path.includes("_cluster/health"))
      return Promise.resolve(makeClusterHealth(opts?.health));
    if (path.includes("_stats"))
      return Promise.resolve(
        makeIndexStats(
          opts?.indices ?? {
            "metrics-2024.01": { queryTotal: 5000, queryTime: 25000 },
            "logs-2024.01": { queryTotal: 8000, queryTime: 16000 },
          },
        ),
      );
    return Promise.resolve({});
  });
}

describe("StreamProcessor", () => {
  beforeEach(() => {
    mockEsFetch.mockReset();
  });

  it("snapshot() produces a window immediately", async () => {
    setupMocks();
    const proc = new StreamProcessor();
    const win = await proc.snapshot();

    expect(win.duration).toBe(30);
    expect(win.cluster.health).toBe("green");
    expect(win.cluster.nodes).toBe(3);
    expect(win.nodes).toHaveLength(1);
    expect(win.nodes[0].name).toBe("es-node-01");
    expect(Object.keys(win.indices)).toContain("metrics-2024.01");
    expect(Object.keys(win.indices)).toContain("logs-2024.01");
  });

  it("poll() returns null until 3 polls accumulated", async () => {
    setupMocks();
    const proc = new StreamProcessor();

    expect(await proc.poll()).toBeNull();
    expect(await proc.poll()).toBeNull();
    const win = await proc.poll(); // 3rd poll → window
    expect(win).not.toBeNull();
    expect(win!.cluster.health).toBe("green");
  });

  it("computes real per-index query deltas", async () => {
    let metricsTotal = 1000;
    let metricsTime = 5000;
    let logsTotal = 2000;
    let logsTime = 4000;

    mockEsFetch.mockImplementation((_method: string, path: string) => {
      if (path.includes("_nodes/stats"))
        return Promise.resolve(makeNodeStats());
      if (path.includes("_cluster/health"))
        return Promise.resolve(makeClusterHealth());
      if (path.includes("_stats")) {
        const result = makeIndexStats({
          "metrics-idx": { queryTotal: metricsTotal, queryTime: metricsTime },
          "logs-idx": { queryTotal: logsTotal, queryTime: logsTime },
        });
        // metrics gets 300 queries (1500ms) per poll, logs gets 100 queries (200ms)
        metricsTotal += 300;
        metricsTime += 1500;
        logsTotal += 100;
        logsTime += 200;
        return Promise.resolve(result);
      }
      return Promise.resolve({});
    });

    const proc = new StreamProcessor();
    await proc.snapshot(); // baseline

    await proc.poll();
    await proc.poll();
    const win = await proc.poll();

    expect(win).not.toBeNull();

    // metrics: 900 queries in 3 polls, avg = 4500ms / 900 = 5ms
    const metrics = win!.indices["metrics-idx"];
    expect(metrics.queryCount).toBe(900);
    expect(metrics.avgLatency).toBe(5);

    // logs: 300 queries in 3 polls, avg = 600ms / 300 = 2ms
    const logs = win!.indices["logs-idx"];
    expect(logs.queryCount).toBe(300);
    expect(logs.avgLatency).toBe(2);
  });

  it("captures yellow health and unassigned shards", async () => {
    setupMocks({ health: "yellow" });
    const proc = new StreamProcessor();
    const win = await proc.snapshot();

    expect(win.cluster.health).toBe("yellow");
    expect(win.cluster.unassignedShards).toBe(2);
  });

  it("captures node stats (heap, cpu, thread pool)", async () => {
    setupMocks({ heap: 88, cpu: 92, searchQueue: 5 });
    const proc = new StreamProcessor();
    const win = await proc.snapshot();

    expect(win.nodes[0].heapPercent).toBe(88);
    expect(win.nodes[0].cpu).toBe(92);
    expect(win.nodes[0].searchThreadPoolQueue).toBe(5);
  });

  it("skips system indices (starting with .)", async () => {
    mockEsFetch.mockImplementation((_method: string, path: string) => {
      if (path.includes("_nodes/stats"))
        return Promise.resolve(makeNodeStats());
      if (path.includes("_cluster/health"))
        return Promise.resolve(makeClusterHealth());
      if (path.includes("_stats"))
        return Promise.resolve(
          makeIndexStats({
            ".kibana": { queryTotal: 10, queryTime: 50 },
            "my-index": { queryTotal: 500, queryTime: 2500 },
          }),
        );
      return Promise.resolve({});
    });

    const proc = new StreamProcessor();
    const win = await proc.snapshot();

    expect(Object.keys(win.indices)).toEqual(["my-index"]);
  });

  it("ring buffer stores windows up to capacity", async () => {
    setupMocks();
    const proc = new StreamProcessor(3); // capacity 3
    await proc.snapshot();
    await proc.snapshot();
    await proc.snapshot();
    await proc.snapshot(); // overwrites first

    expect(proc.windows.length).toBe(3);
  });
});
