import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { esFetch } from "../../es-client.js";

export function registerCancelTask(server: McpServer): void {
  server.registerTool("cancel_task", {
    title: "Cancel Task",
    description:
      "Cancel a running Elasticsearch task (e.g. a long-running search query). " +
      "Always safe to call — cancelling a bad query prevents resource waste.",
    inputSchema: {
      task_id: z
        .string()
        .describe("Task ID to cancel (format: 'node_id:task_number')"),
    },
  }, async ({ task_id }) => {
    try {
      const result = await esFetch(
        "POST",
        `/_tasks/${encodeURIComponent(task_id)}/_cancel`,
      );
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            action: "cancel_task",
            task_id,
            result,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            action: "cancel_task",
            task_id,
            error: err instanceof Error ? err.message : String(err),
          }, null, 2),
        }],
        isError: true,
      };
    }
  });
}
