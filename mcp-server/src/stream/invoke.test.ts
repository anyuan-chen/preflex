import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildAgentMessage, invokeAgent, getInvocationHistory } from "./invoke.js";
import type { Anomaly } from "./anomaly.js";
import type { Window } from "./window.js";

// ---------------------------------------------------------------------------
// Mock config + fetch
// ---------------------------------------------------------------------------

vi.mock("../config.js", () => ({
  config: {
    esUrl: "http://localhost:9210",
    esUser: "elastic",
    esPassword: "changeme",
    kibanaUrl: "http://localhost:5601",
    agentId: "optimizer",
  },
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnomaly(overrides?: Partial<Anomaly>): Anomaly {
  return {
    rule: "latency_spike",
    severity: "warning",
    description: "test-idx avg latency 50ms (baseline 10ms, 5.0x)",
    ...overrides,
  };
}

function makeWindow(overrides?: Partial<Window>): Window {
  return {
    timestamp: Date.now(),
    duration: 30,
    indices: {
      "test-idx": {
        queryCount: 3000,
        queryRate: 100,
        avgLatency: 50,
        errorCount: 0,
      },
    },
    cluster: {
      health: "green",
      nodes: 3,
      activeShards: 48,
      unassignedShards: 0,
    },
    nodes: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildAgentMessage", () => {
  it("includes anomaly summary with severity tags", () => {
    const anomalies = [
      makeAnomaly({ severity: "critical", description: "Cluster RED" }),
      makeAnomaly({ severity: "warning", description: "Latency high" }),
    ];
    const msg = buildAgentMessage(anomalies, [makeWindow()]);

    expect(msg).toContain("ANOMALY DETECTED:");
    expect(msg).toContain("[CRITICAL] Cluster RED");
    expect(msg).toContain("[WARNING] Latency high");
  });

  it("includes the digest rendering of windows", () => {
    const win = makeWindow();
    const msg = buildAgentMessage([makeAnomaly()], [win]);

    // Digest should include cluster health and index stats
    expect(msg).toContain("GREEN");
    expect(msg).toContain("test-idx");
  });

  it("includes action instruction", () => {
    const msg = buildAgentMessage([makeAnomaly()], [makeWindow()]);
    expect(msg).toContain("Investigate and fix if possible");
  });
});

describe("invokeAgent", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("calls Kibana converse API with correct URL and body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversation_id: "conv-123",
        output: "I investigated and found...",
      }),
    });

    const anomalies = [makeAnomaly()];
    const windows = [makeWindow()];
    const result = await invokeAgent(anomalies, windows);

    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:5601/api/agent_builder/converse");
    expect(opts.method).toBe("POST");
    expect(opts.headers["kbn-xsrf"]).toBe("true");
    expect(opts.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(opts.body);
    expect(body.agent_id).toBe("optimizer");
    expect(body.input).toContain("ANOMALY DETECTED:");
  });

  it("returns success result with conversation ID", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversation_id: "conv-456",
        output: "Fixed the issue",
      }),
    });

    const result = await invokeAgent([makeAnomaly()], [makeWindow()]);

    expect(result.success).toBe(true);
    expect(result.conversationId).toBe("conv-456");
    expect(result.agentResponse).toBe("Fixed the issue");
  });

  it("returns error result on HTTP failure", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "Service unavailable",
    });

    const result = await invokeAgent([makeAnomaly()], [makeWindow()]);

    expect(result.success).toBe(false);
    expect(result.error).toContain("503");
    expect(result.error).toContain("Service unavailable");
  });

  it("returns error result on network failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Connection refused"));

    const result = await invokeAgent([makeAnomaly()], [makeWindow()]);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Connection refused");
  });

  it("records invocations in history", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ conversation_id: "c1", output: "ok" }),
    });

    const beforeLen = getInvocationHistory().length;
    await invokeAgent([makeAnomaly()], [makeWindow()]);
    const afterLen = getInvocationHistory().length;

    expect(afterLen).toBe(beforeLen + 1);

    const latest = getInvocationHistory()[getInvocationHistory().length - 1];
    expect(latest.result.success).toBe(true);
    expect(latest.digest).toContain("ANOMALY DETECTED:");
    expect(latest.anomalies).toHaveLength(1);
  });

  it("records failed invocations in history too", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout"));

    const beforeLen = getInvocationHistory().length;
    await invokeAgent([makeAnomaly()], [makeWindow()]);
    const afterLen = getInvocationHistory().length;

    expect(afterLen).toBe(beforeLen + 1);

    const latest = getInvocationHistory()[getInvocationHistory().length - 1];
    expect(latest.result.success).toBe(false);
    expect(latest.result.error).toBe("timeout");
  });

  it("uses Basic auth with configured credentials", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ output: "ok" }),
    });

    await invokeAgent([makeAnomaly()], [makeWindow()]);

    const [, opts] = fetchMock.mock.calls[0];
    const expected = Buffer.from("elastic:changeme").toString("base64");
    expect(opts.headers.Authorization).toBe(`Basic ${expected}`);
  });
});
