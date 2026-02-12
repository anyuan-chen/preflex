import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestPair, parseResult, type ToolResult } from "./test-helpers.js";
import {
  storePendingOperation,
  listPendingOperations,
  removePendingOperation,
} from "./operation-store.js";

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
    }
  },
}));

vi.mock("../../config.js", () => ({
  config: {
    verifyMode: "hitl",
    esUrl: "http://localhost:9200",
    esUser: "elastic",
    esPassword: "changeme",
    mcpPort: 3100,
  },
}));

const { registerConfirmOperation } = await import("./confirm-operation.js");
const { registerCancelOperation } = await import("./cancel-operation.js");

describe("HITL flow — confirm + cancel operations", () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    mockEsFetch.mockReset();
    for (const op of listPendingOperations()) {
      removePendingOperation(op.id);
    }
    const pair = await createTestPair((server) => {
      registerConfirmOperation(server);
      registerCancelOperation(server);
    });
    callTool = pair.callTool;
    cleanup = pair.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  describe("confirm_operation", () => {
    it("executes a pending update_settings operation", async () => {
      const opId = storePendingOperation(
        "update_settings",
        { index: "my-idx", settings: { "index.number_of_replicas": 0 } },
        {},
      );

      mockEsFetch
        .mockResolvedValueOnce({ "my-idx": { settings: { "index.number_of_replicas": "1" } } })  // before
        .mockResolvedValueOnce({ acknowledged: true })  // PUT
        .mockResolvedValueOnce({ "my-idx": { settings: { "index.number_of_replicas": "0" } } })  // after
        .mockResolvedValueOnce({ status: "green" });  // health

      const result = await callTool("confirm_operation", { operation_id: opId });

      const data = parseResult(result);
      expect(data.confirmed).toBe(true);
      expect(data.operation_id).toBe(opId);
      expect(data.success).toBe(true);
      expect(data.action).toBe("update_settings");

      // Operation removed from store
      expect(listPendingOperations()).toHaveLength(0);
    });

    it("executes a pending reindex operation", async () => {
      const opId = storePendingOperation(
        "reindex",
        {
          source_index: "src",
          target_index: "tgt",
          target_mappings: { ts: { type: "date" } },
        },
        {},
      );

      mockEsFetch
        .mockResolvedValueOnce({ count: 200 })  // source count
        .mockResolvedValueOnce({ acknowledged: true })  // PUT target
        .mockResolvedValueOnce({ created: 200, failures: [] })  // _reindex
        .mockResolvedValueOnce({ count: 200 })  // target count
        .mockResolvedValueOnce({});  // target mapping

      const result = await callTool("confirm_operation", { operation_id: opId });

      const data = parseResult(result);
      expect(data.confirmed).toBe(true);
      expect(data.success).toBe(true);
      expect(data.action).toBe("reindex");
      expect(data.source_count).toBe(200);
      expect(data.target_count).toBe(200);
    });

    it("executes a pending manage_aliases operation", async () => {
      const opId = storePendingOperation(
        "manage_aliases",
        {
          actions: [
            { action: "add", index: "new-idx", alias: "prod" },
            { action: "remove", index: "old-idx", alias: "prod" },
          ],
        },
        {},
      );

      mockEsFetch
        .mockResolvedValueOnce({ acknowledged: true })  // POST _aliases
        .mockResolvedValueOnce({ "new-idx": { aliases: { prod: {} } } });  // verify

      const result = await callTool("confirm_operation", { operation_id: opId });

      const data = parseResult(result);
      expect(data.confirmed).toBe(true);
      expect(data.success).toBe(true);
      expect(data.action).toBe("manage_aliases");
    });

    it("returns error for nonexistent operation", async () => {
      const result = await callTool("confirm_operation", {
        operation_id: "nonexistent",
      });

      const data = parseResult(result);
      expect(data.success).toBe(false);
      expect(data.error).toContain("No pending operation");
      expect(result.isError).toBe(true);
    });

    it("preserves operation on execution failure", async () => {
      const opId = storePendingOperation(
        "update_settings",
        { index: "bad-idx", settings: { "index.number_of_replicas": 0 } },
        {},
      );

      mockEsFetch
        .mockResolvedValueOnce({})  // before settings
        .mockRejectedValueOnce(new Error("ES unavailable"));  // PUT fails

      const result = await callTool("confirm_operation", { operation_id: opId });

      const data = parseResult(result);
      expect(data.confirmed).toBe(false);
      expect(data.error).toContain("ES unavailable");
      expect(data.message).toContain("preserved");
      expect(result.isError).toBe(true);

      // Operation still in store
      expect(listPendingOperations()).toHaveLength(1);
    });
  });

  describe("cancel_operation", () => {
    it("removes pending operation without executing", async () => {
      const opId = storePendingOperation(
        "reindex",
        { source: "a", target: "b" },
        {},
      );

      const result = await callTool("cancel_operation", { operation_id: opId });

      const data = parseResult(result);
      expect(data.cancelled).toBe(true);
      expect(data.operation_id).toBe(opId);
      expect(data.action).toBe("reindex");
      expect(data.message).toContain("No changes");

      // No ES calls
      expect(mockEsFetch).not.toHaveBeenCalled();

      // Removed from store
      expect(listPendingOperations()).toHaveLength(0);
    });

    it("returns error for nonexistent operation", async () => {
      const result = await callTool("cancel_operation", {
        operation_id: "nonexistent",
      });

      const data = parseResult(result);
      expect(data.success).toBe(false);
      expect(data.error).toContain("No pending operation");
      expect(result.isError).toBe(true);
    });
  });

  describe("list_pending_operations", () => {
    it("returns empty list when no pending operations", async () => {
      const result = await callTool("list_pending_operations", {});

      const data = parseResult(result);
      expect(data.count).toBe(0);
      expect(data.operations).toEqual([]);
    });

    it("returns all pending operations", async () => {
      storePendingOperation("reindex", { a: 1 }, { preview: "reindex" });
      storePendingOperation("update_settings", { b: 2 }, { preview: "settings" });

      const result = await callTool("list_pending_operations", {});

      const data = parseResult(result);
      expect(data.count).toBe(2);
      const ops = data.operations as Array<Record<string, unknown>>;
      const actions = ops.map((o) => o.action).sort();
      expect(actions).toEqual(["reindex", "update_settings"]);
      // Each op has operation_id, action, created_at, preview
      for (const op of ops) {
        expect(op).toHaveProperty("operation_id");
        expect(op).toHaveProperty("action");
        expect(op).toHaveProperty("created_at");
        expect(op).toHaveProperty("preview");
      }
    });
  });

  describe("full HITL workflow", () => {
    it("confirm after store → executes and removes", async () => {
      // Store an operation (simulating what a write tool would do in HITL mode)
      const opId = storePendingOperation(
        "update_settings",
        { index: "test", settings: { "index.number_of_replicas": 2 } },
        { current: "1", proposed: "2" },
      );

      expect(listPendingOperations()).toHaveLength(1);

      // Confirm it
      mockEsFetch
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ acknowledged: true })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ status: "green" });

      const result = await callTool("confirm_operation", { operation_id: opId });
      const data = parseResult(result);
      expect(data.confirmed).toBe(true);

      // Store is now empty
      expect(listPendingOperations()).toHaveLength(0);

      // Can't confirm again
      const result2 = await callTool("confirm_operation", { operation_id: opId });
      expect(parseResult(result2).success).toBe(false);
    });

    it("cancel after store → removes without executing", async () => {
      const opId = storePendingOperation(
        "reindex",
        { source_index: "a", target_index: "b", target_mappings: {} },
        {},
      );

      const result = await callTool("cancel_operation", { operation_id: opId });
      expect(parseResult(result).cancelled).toBe(true);
      expect(listPendingOperations()).toHaveLength(0);
      expect(mockEsFetch).not.toHaveBeenCalled();
    });
  });
});
