import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { esFetch } from "../../es-client.js";

export function registerShardInfo(server: McpServer): void {
  server.registerTool("shard_info", {
    title: "Shard Info",
    description:
      "List every shard: which node it's on, STARTED/UNASSIGNED state, doc count, store size. " +
      "Essential for diagnosing over-sharding and replica allocation problems.",
    inputSchema: {
      pattern: z
        .string()
        .default("*")
        .describe("Index name or pattern"),
    },
  }, async ({ pattern }) => {
    const result = await esFetch(
      "GET",
      `/_cat/shards/${encodeURIComponent(pattern)}?format=json&h=index,shard,prirep,state,docs,store,node&s=index,shard`,
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  });
}
