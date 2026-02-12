import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { esFetch } from "../../es-client.js";

export function registerQueryProfile(server: McpServer): void {
  server.registerTool("query_profile", {
    title: "Query Profile",
    description:
      "Run a search query with profiling enabled. Returns per-shard timing breakdown: " +
      "time per query clause, rewrite time, collector time. Use to identify slow query components.",
    inputSchema: {
      index: z.string().describe("Index to search"),
      query: z.record(z.string(), z.any()).describe("Elasticsearch Query DSL object"),
      size: z.number().int().default(0).describe("Number of hits to return (0 for agg-only profiling)"),
    },
  }, async ({ index, query, size }) => {
    const result = await esFetch(
      "POST",
      `/${encodeURIComponent(index)}/_search`,
      { query, size, profile: true },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  });
}
