import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { esFetch } from "../../es-client.js";

export function registerClusterHealth(server: McpServer): void {
  server.registerTool("cluster_health", {
    title: "Cluster Health",
    description:
      "Get Elasticsearch cluster health status including per-index breakdown. " +
      "Returns status (green/yellow/red), node count, active/unassigned shards.",
    inputSchema: {
      level: z
        .enum(["cluster", "indices", "shards"])
        .default("indices")
        .describe("Detail level: cluster, indices, or shards"),
    },
  }, async ({ level }) => {
    const result = await esFetch("GET", `/_cluster/health?level=${level}`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  });
}
