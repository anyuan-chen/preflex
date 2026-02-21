import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestPair, parseResult, type ToolResult } from "./test-helpers.js";
import { listPendingOperations, removePendingOperation } from "./operation-store.js";

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

const { registerReindex } = await import("./reindex.js");

describe("reindex tool", () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    mockEsFetch.mockReset();
    mockVerifyMode = "auto";
    for (const op of listPendingOperations()) {
      removePendingOperation(op.id);
    }
    const pair = await createTestPair((server) => registerReindex(server));
    callTool = pair.callTool;
    cleanup = pair.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  describe("auto mode", () => {
    it("creates target, reindexes, and verifies doc count", async () => {
      mockEsFetch
        .mockResolvedValueOnce({ count: 500 })  // source _count
        .mockResolvedValueOnce({ acknowledged: true })  // PUT target
        .mockResolvedValueOnce({ created: 500, failures: [] })  // _reindex
        .mockResolvedValueOnce({ _shards: { successful: 1 } })  // target _refresh
        .mockResolvedValueOnce({ count: 500 })  // target _count
        .mockResolvedValueOnce({ "target": { mappings: { properties: { ts: { type: "date" } } } } });  // target _mapping

      const result = await callTool("reindex", {
        source_index: "source",
        target_index: "target",
        target_mappings: { ts: { type: "date" } },
      });

      const data = parseResult(result);
      expect(data.success).toBe(true);
      expect(data.source_count).toBe(500);
      expect(data.target_count).toBe(500);
      expect(data.action).toBe("reindex");
    });

    it("creates target with settings when provided", async () => {
      mockEsFetch
        .mockResolvedValueOnce({ count: 100 })
        .mockResolvedValueOnce({ acknowledged: true })
        .mockResolvedValueOnce({ created: 100, failures: [] })
        .mockResolvedValueOnce({ _shards: { successful: 1 } })  // _refresh
        .mockResolvedValueOnce({ count: 100 })
        .mockResolvedValueOnce({});

      await callTool("reindex", {
        source_index: "src",
        target_index: "tgt",
        target_mappings: { f: { type: "keyword" } },
        target_settings: { "index.number_of_shards": 1 },
      });

      // Check the PUT call includes settings
      const putCall = mockEsFetch.mock.calls[1];
      expect(putCall[0]).toBe("PUT");
      expect(putCall[2]).toEqual({
        mappings: { properties: { f: { type: "keyword" } } },
        settings: { "index.number_of_shards": 1 },
      });
    });

    it("returns error and cleans up when reindex fails", async () => {
      mockEsFetch
        .mockResolvedValueOnce({ count: 100 })  // source _count
        .mockResolvedValueOnce({ acknowledged: true })  // PUT target
        .mockRejectedValueOnce(new Error("reindex failed"))  // _reindex fails
        .mockResolvedValueOnce({ acknowledged: true });  // DELETE target (cleanup)

      const result = await callTool("reindex", {
        source_index: "src",
        target_index: "tgt",
        target_mappings: { f: { type: "text" } },
      });

      const data = parseResult(result);
      expect(data.success).toBe(false);
      expect(data.step).toBe("reindex");
      expect(data.rollback).toBe("Target index deleted");
      expect(result.isError).toBe(true);
    });

    it("returns error when target creation fails", async () => {
      mockEsFetch
        .mockResolvedValueOnce({ count: 100 })  // source _count
        .mockRejectedValueOnce(new Error("index already exists"));  // PUT target fails

      const result = await callTool("reindex", {
        source_index: "src",
        target_index: "existing-index",
        target_mappings: { f: { type: "text" } },
      });

      const data = parseResult(result);
      expect(data.success).toBe(false);
      expect(data.step).toBe("create_target_index");
      expect(result.isError).toBe(true);
    });

    it("reports verification failure on doc count mismatch", async () => {
      mockEsFetch
        .mockResolvedValueOnce({ count: 500 })  // source _count
        .mockResolvedValueOnce({ acknowledged: true })
        .mockResolvedValueOnce({ created: 490, failures: [] })
        .mockResolvedValueOnce({ _shards: { successful: 1 } })  // _refresh
        .mockResolvedValueOnce({ count: 490 })  // target _count (mismatch!)
        .mockResolvedValueOnce({});

      const result = await callTool("reindex", {
        source_index: "src",
        target_index: "tgt",
        target_mappings: { f: { type: "text" } },
      });

      const data = parseResult(result);
      expect(data.success).toBe(false);
      expect(data.step).toBe("verification");
      expect((data.details as string[]).some((d: string) => d.includes("Doc count mismatch"))).toBe(true);
    });

    it("reports verification failure on reindex failures array", async () => {
      mockEsFetch
        .mockResolvedValueOnce({ count: 100 })
        .mockResolvedValueOnce({ acknowledged: true })
        .mockResolvedValueOnce({ created: 99, failures: [{ cause: "mapping error" }] })
        .mockResolvedValueOnce({ _shards: { successful: 1 } })  // _refresh
        .mockResolvedValueOnce({ count: 99 })
        .mockResolvedValueOnce({});

      const result = await callTool("reindex", {
        source_index: "src",
        target_index: "tgt",
        target_mappings: { f: { type: "text" } },
      });

      const data = parseResult(result);
      expect(data.success).toBe(false);
      expect((data.details as string[]).some((d: string) => d.includes("reindex failures"))).toBe(true);
    });
  });

  describe("hitl mode", () => {
    beforeEach(() => {
      mockVerifyMode = "hitl";
    });

    it("returns preview with source info", async () => {
      mockEsFetch
        .mockResolvedValueOnce({ "src": { mappings: { properties: { ts: { type: "text" } } } } })  // source mapping
        .mockResolvedValueOnce({ count: 1000 });  // source count

      const result = await callTool("reindex", {
        source_index: "src",
        target_index: "tgt",
        target_mappings: { ts: { type: "date" } },
      });

      const data = parseResult(result);
      expect(data.mode).toBe("preview");
      expect(data.operation_id).toBeDefined();
      expect(data.source_doc_count).toBe(1000);
      expect(data.proposed_mappings).toEqual({ ts: { type: "date" } });

      // No PUT or _reindex calls
      expect(mockEsFetch).toHaveBeenCalledTimes(2);
    });

    it("stores operation for later confirmation", async () => {
      mockEsFetch
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ count: 100 });

      await callTool("reindex", {
        source_index: "src",
        target_index: "tgt",
        target_mappings: { f: { type: "keyword" } },
        target_settings: { "index.number_of_shards": 2 },
      });

      const pending = listPendingOperations();
      expect(pending).toHaveLength(1);
      expect(pending[0].action).toBe("reindex");
      expect(pending[0].params).toEqual({
        source_index: "src",
        target_index: "tgt",
        target_mappings: { f: { type: "keyword" } },
        target_settings: { "index.number_of_shards": 2 },
      });
    });
  });
});
