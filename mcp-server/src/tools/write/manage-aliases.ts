import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { esFetch } from "../../es-client.js";
import { config } from "../../config.js";
import { storePendingOperation } from "./operation-store.js";

export function registerManageAliases(server: McpServer): void {
  server.registerTool("manage_aliases", {
    title: "Manage Aliases",
    description:
      "Atomically add/remove index aliases. All actions in a single call are applied atomically — " +
      "if any action fails, all are rolled back. Use for zero-downtime index swaps after reindex.",
    inputSchema: {
      actions: z
        .array(
          z.object({
            action: z.enum(["add", "remove"]).describe("Whether to add or remove the alias"),
            index: z.string().describe("Index name"),
            alias: z.string().describe("Alias name"),
          }),
        )
        .describe("List of alias actions to execute atomically"),
    },
  }, async ({ actions }) => {
    if (config.verifyMode === "hitl") {
      const preview = {
        action: "manage_aliases",
        proposed_actions: actions,
      };
      const opId = storePendingOperation("manage_aliases", { actions }, preview);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            mode: "preview",
            operation_id: opId,
            ...preview,
            message: `HITL mode: review the proposed alias changes. Use confirm_operation("${opId}") to apply or cancel_operation("${opId}") to discard.`,
          }, null, 2),
        }],
      };
    }

    // Build the ES _aliases request body
    const esActions = actions.map((a) => ({
      [a.action]: { index: a.index, alias: a.alias },
    }));

    try {
      const result = await esFetch("POST", "/_aliases", { actions: esActions });

      // Verify each alias points to the right place
      const aliasNames = [...new Set(actions.filter((a) => a.action === "add").map((a) => a.alias))];
      const verification: Record<string, unknown> = {};
      for (const alias of aliasNames) {
        try {
          verification[alias] = await esFetch("GET", `/_alias/${encodeURIComponent(alias)}`);
        } catch {
          verification[alias] = "not found";
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            action: "manage_aliases",
            applied_actions: actions,
            result,
            alias_verification: verification,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            action: "manage_aliases",
            error: err instanceof Error ? err.message : String(err),
            message: "Alias operation failed. No changes were applied (atomic rollback).",
          }, null, 2),
        }],
        isError: true,
      };
    }
  });
}
