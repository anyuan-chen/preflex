import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { esFetch } from "../../es-client.js";

export function registerRunningTasks(server: McpServer): void {
  server.registerTool("running_tasks", {
    title: "Running Tasks",
    description:
      "List currently running search tasks with durations and query bodies. " +
      "Use to find long-running or stuck queries that may need to be cancelled.",
  }, async () => {
    const result = await esFetch(
      "GET",
      "/_tasks?detailed=true&actions=*search*",
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  });
}
