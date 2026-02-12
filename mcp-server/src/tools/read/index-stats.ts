import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { esFetch } from "../../es-client.js";

export function registerIndexStats(server: McpServer): void {
  server.registerTool("index_stats", {
    title: "Index Stats",
    description:
      "Live performance metrics for an index: search query count/latency, " +
      "indexing rate, fielddata evictions, query cache hit ratios, segment counts, store size.",
    inputSchema: {
      index: z.string().describe("Index name"),
    },
  }, async ({ index }) => {
    const result = await esFetch(
      "GET",
      `/${encodeURIComponent(index)}/_stats/search,indexing,fielddata,query_cache,segments,store`,
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  });
}
