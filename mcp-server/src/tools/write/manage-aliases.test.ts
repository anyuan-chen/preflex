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

const { registerManageAliases } = await import("./manage-aliases.js");

describe("manage_aliases tool", () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    mockEsFetch.mockReset();
    mockVerifyMode = "auto";
    for (const op of listPendingOperations()) {
      removePendingOperation(op.id);
    }
    const pair = await createTestPair((server) => registerManageAliases(server));
    callTool = pair.callTool;
    cleanup = pair.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  describe("auto mode", () => {
    it("applies alias actions and verifies", async () => {
      mockEsFetch
        .mockResolvedValueOnce({ acknowledged: true })  // POST _aliases
        .mockResolvedValueOnce({ "new-idx": { aliases: { "my-alias": {} } } });  // GET _alias verification

      const result = await callTool("manage_aliases", {
        actions: [
          { action: "remove", index: "old-idx", alias: "my-alias" },
          { action: "add", index: "new-idx", alias: "my-alias" },
        ],
      });

      const data = parseResult(result);
      expect(data.success).toBe(true);
      expect(data.alias_verification).toHaveProperty("my-alias");
    });

    it("sends correctly formatted ES actions", async () => {
      mockEsFetch
        .mockResolvedValueOnce({ acknowledged: true })
        .mockResolvedValueOnce({});

      await callTool("manage_aliases", {
        actions: [
          { action: "add", index: "idx-v2", alias: "current" },
        ],
      });

      const postCall = mockEsFetch.mock.calls[0];
      expect(postCall[0]).toBe("POST");
      expect(postCall[1]).toBe("/_aliases");
      expect(postCall[2]).toEqual({
        actions: [{ add: { index: "idx-v2", alias: "current" } }],
      });
    });

    it("returns error when alias operation fails", async () => {
      mockEsFetch.mockRejectedValueOnce(new Error("alias conflict"));

      const result = await callTool("manage_aliases", {
        actions: [
          { action: "add", index: "idx", alias: "test" },
        ],
      });

      const data = parseResult(result);
      expect(data.success).toBe(false);
      expect(data.error).toContain("alias conflict");
      expect(data.message).toContain("atomic rollback");
      expect(result.isError).toBe(true);
    });

    it("only verifies 'add' aliases, not 'remove'", async () => {
      mockEsFetch.mockResolvedValueOnce({ acknowledged: true });

      await callTool("manage_aliases", {
        actions: [
          { action: "remove", index: "old", alias: "gone" },
        ],
      });

      // Only 1 call: POST _aliases. No verification GETs for removed aliases.
      expect(mockEsFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("hitl mode", () => {
    beforeEach(() => {
      mockVerifyMode = "hitl";
    });

    it("returns preview without applying", async () => {
      const result = await callTool("manage_aliases", {
        actions: [
          { action: "add", index: "new", alias: "prod" },
          { action: "remove", index: "old", alias: "prod" },
        ],
      });

      const data = parseResult(result);
      expect(data.mode).toBe("preview");
      expect(data.operation_id).toBeDefined();
      expect(data.proposed_actions).toHaveLength(2);
      expect(mockEsFetch).not.toHaveBeenCalled();
    });

    it("stores operation in pending store", async () => {
      await callTool("manage_aliases", {
        actions: [{ action: "add", index: "idx", alias: "a" }],
      });

      const pending = listPendingOperations();
      expect(pending).toHaveLength(1);
      expect(pending[0].action).toBe("manage_aliases");
    });
  });
});
