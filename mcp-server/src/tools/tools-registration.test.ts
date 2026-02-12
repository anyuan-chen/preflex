import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadTools } from "./read/index.js";
import { registerWriteTools } from "./write/index.js";

describe("tool registration", () => {
  let server: McpServer;
  let registeredTools: string[];

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.1" });
    registeredTools = [];

    // Spy on registerTool to capture tool names
    const originalRegisterTool = server.registerTool.bind(server);
    server.registerTool = vi.fn(((name: string, ...args: unknown[]) => {
      registeredTools.push(name);
      return originalRegisterTool(name, ...args);
    }) as typeof server.registerTool);
  });

  describe("read tools", () => {
    it("registers all 11 read tools", () => {
      registerReadTools(server);
      expect(registeredTools).toHaveLength(11);
    });

    it("registers expected tool names", () => {
      registerReadTools(server);
      expect(registeredTools).toContain("cluster_health");
      expect(registeredTools).toContain("index_info");
      expect(registeredTools).toContain("shard_info");
      expect(registeredTools).toContain("node_stats");
      expect(registeredTools).toContain("index_mapping");
      expect(registeredTools).toContain("field_caps");
      expect(registeredTools).toContain("index_settings");
      expect(registeredTools).toContain("index_stats");
      expect(registeredTools).toContain("allocation_explain");
      expect(registeredTools).toContain("query_profile");
      expect(registeredTools).toContain("running_tasks");
    });
  });

  describe("write tools", () => {
    it("registers all 8 write + HITL tools", () => {
      registerWriteTools(server);
      expect(registeredTools).toHaveLength(8);
    });

    it("registers expected tool names", () => {
      registerWriteTools(server);
      expect(registeredTools).toContain("update_settings");
      expect(registeredTools).toContain("reindex");
      expect(registeredTools).toContain("shrink_index");
      expect(registeredTools).toContain("manage_aliases");
      expect(registeredTools).toContain("cancel_task");
      expect(registeredTools).toContain("confirm_operation");
      expect(registeredTools).toContain("cancel_operation");
      expect(registeredTools).toContain("list_pending_operations");
    });
  });

  describe("all tools combined", () => {
    it("registers 19 total tools", () => {
      registerReadTools(server);
      registerWriteTools(server);
      expect(registeredTools).toHaveLength(19);
    });

    it("has no duplicate names", () => {
      registerReadTools(server);
      registerWriteTools(server);
      const unique = new Set(registeredTools);
      expect(unique.size).toBe(registeredTools.length);
    });
  });
});
