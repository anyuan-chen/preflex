import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestPair, parseResult, type ToolResult } from "./test-helpers.js";

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

const { registerCancelTask } = await import("./cancel-task.js");

describe("cancel_task tool", () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    mockEsFetch.mockReset();
    const pair = await createTestPair((server) => registerCancelTask(server));
    callTool = pair.callTool;
    cleanup = pair.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it("cancels a task successfully", async () => {
    mockEsFetch.mockResolvedValueOnce({ nodes: {} });

    const result = await callTool("cancel_task", {
      task_id: "node1:12345",
    });

    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.task_id).toBe("node1:12345");

    expect(mockEsFetch).toHaveBeenCalledWith(
      "POST",
      "/_tasks/node1%3A12345/_cancel",
    );
  });

  it("returns error when cancellation fails", async () => {
    mockEsFetch.mockRejectedValueOnce(new Error("task not found"));

    const result = await callTool("cancel_task", {
      task_id: "bad:99999",
    });

    const data = parseResult(result);
    expect(data.success).toBe(false);
    expect(data.error).toContain("task not found");
    expect(result.isError).toBe(true);
  });
});
