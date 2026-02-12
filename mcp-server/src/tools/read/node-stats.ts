import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { esFetch } from "../../es-client.js";

export function registerNodeStats(server: McpServer): void {
  server.registerTool("node_stats", {
    title: "Node Stats",
    description:
      "Per-node performance metrics: heap usage, GC pressure, search/indexing latency, " +
      "thread pool queue/rejections. Use to identify resource bottlenecks.",
  }, async () => {
    const result = await esFetch("GET", "/_nodes/stats/indices,jvm,thread_pool");
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  });
}
