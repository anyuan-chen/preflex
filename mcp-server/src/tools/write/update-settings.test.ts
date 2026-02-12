import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestPair, parseResult, type ToolResult } from "./test-helpers.js";
import { listPendingOperations, removePendingOperation } from "./operation-store.js";

// Mock esFetch
const mockEsFetch = vi.fn();
vi.mock("../../es-client.js", () => ({
  esFetch: (...args: unknown[]) => mockEsFetch(...args),
  EsError: class EsError extends Error {
    constructor(
      public method: string,
      public path: string,
      public status: number,
      public body: string,
    ) {
      super(`ES ${method} ${path} → ${status}: ${body}`);
      this.name = "EsError";
    }
  },
}));

// Mock config — default to auto mode
let mockVerifyMode = "auto";
vi.mock("../../config.js", () => ({
  config: {
    get verifyMode() { return mockVerifyMode; },
    esUrl: "http://localhost:9200",
    esUser: "elastic",
    esPassword: "changeme",
    mcpPort: 3100,
  },
}));

// Import after mocks
const { registerUpdateSettings } = await import("./update-settings.js");

describe("update_settings tool", () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    mockEsFetch.mockReset();
    mockVerifyMode = "auto";
    // Clear pending operations
    for (const op of listPendingOperations()) {
      removePendingOperation(op.id);
    }
    const pair = await createTestPair((server) => registerUpdateSettings(server));
    callTool = pair.callTool;
    cleanup = pair.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  describe("auto mode", () => {
    it("applies settings and reads back", async () => {
      const beforeSettings = { "test-index": { settings: { "index.number_of_replicas": "1" } } };
      const afterSettings = { "test-index": { settings: { "index.number_of_replicas": "0" } } };
      const health = { status: "green", number_of_nodes: 1 };

      mockEsFetch
        .mockResolvedValueOnce(beforeSettings)  // GET settings before
        .mockResolvedValueOnce({ acknowledged: true })  // PUT settings
        .mockResolvedValueOnce(afterSettings)  // GET settings after
        .mockResolvedValueOnce(health);  // GET health

      const result = await callTool("update_settings", {
        index: "test-index",
        settings: { "index.number_of_replicas": 0 },
      });

      const data = parseResult(result);
      expect(data.success).toBe(true);
      expect(data.action).toBe("update_settings");
      expect(data.index).toBe("test-index");
      expect(data.applied_settings).toEqual({ "index.number_of_replicas": 0 });
      expect(data.before_settings).toEqual(beforeSettings);
      expect(data.after_settings).toEqual(afterSettings);
      expect(data.cluster_health).toEqual(health);
    });

    it("calls ES endpoints in correct order", async () => {
      mockEsFetch
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ acknowledged: true })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ status: "green" });

      await callTool("update_settings", {
        index: "my-idx",
        settings: { "index.refresh_interval": "30s" },
      });

      expect(mockEsFetch).toHaveBeenCalledTimes(4);
      // 1. Read current settings
      expect(mockEsFetch.mock.calls[0][0]).toBe("GET");
      expect(mockEsFetch.mock.calls[0][1]).toContain("/_settings");
      // 2. Apply new settings
      expect(mockEsFetch.mock.calls[1][0]).toBe("PUT");
      expect(mockEsFetch.mock.calls[1][1]).toContain("/_settings");
      expect(mockEsFetch.mock.calls[1][2]).toEqual({ "index.refresh_interval": "30s" });
      // 3. Read back
      expect(mockEsFetch.mock.calls[2][0]).toBe("GET");
      // 4. Health check
      expect(mockEsFetch.mock.calls[3][0]).toBe("GET");
      expect(mockEsFetch.mock.calls[3][1]).toContain("/_cluster/health");
    });

    it("returns error when PUT fails", async () => {
      mockEsFetch
        .mockResolvedValueOnce({}) // GET before
        .mockRejectedValueOnce(new Error("index_not_found")); // PUT fails

      const result = await callTool("update_settings", {
        index: "missing-index",
        settings: { "index.number_of_replicas": 0 },
      });

      const data = parseResult(result);
      expect(data.success).toBe(false);
      expect(data.error).toContain("index_not_found");
      expect(result.isError).toBe(true);
    });
  });

  describe("hitl mode", () => {
    beforeEach(() => {
      mockVerifyMode = "hitl";
    });

    it("returns preview without applying changes", async () => {
      const currentSettings = { "test-index": { settings: { "index.number_of_replicas": "3" } } };
      mockEsFetch.mockResolvedValueOnce(currentSettings);

      const result = await callTool("update_settings", {
        index: "test-index",
        settings: { "index.number_of_replicas": 0 },
      });

      const data = parseResult(result);
      expect(data.mode).toBe("preview");
      expect(data.operation_id).toBeDefined();
      expect(typeof data.operation_id).toBe("string");
      expect(data.action).toBe("update_settings");
      expect(data.proposed_settings).toEqual({ "index.number_of_replicas": 0 });
      expect(data.current_settings).toEqual(currentSettings);
      expect(data.message).toContain("confirm_operation");

      // Only 1 ES call (read current settings), no PUT
      expect(mockEsFetch).toHaveBeenCalledTimes(1);
      expect(mockEsFetch.mock.calls[0][0]).toBe("GET");
    });

    it("stores operation in pending store", async () => {
      mockEsFetch.mockResolvedValueOnce({});

      const result = await callTool("update_settings", {
        index: "test-index",
        settings: { "index.number_of_replicas": 0 },
      });

      const data = parseResult(result);
      const pending = listPendingOperations();
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(data.operation_id);
      expect(pending[0].action).toBe("update_settings");
      expect(pending[0].params).toEqual({
        index: "test-index",
        settings: { "index.number_of_replicas": 0 },
      });
    });
  });
});
