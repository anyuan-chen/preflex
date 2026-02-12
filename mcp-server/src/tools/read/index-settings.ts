import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { esFetch } from "../../es-client.js";

export function registerIndexSettings(server: McpServer): void {
  server.registerTool("index_settings", {
    title: "Index Settings",
    description:
      "Get all settings for an index including defaults: shard count, replica count, " +
      "refresh interval, slow log thresholds, allocation rules. Flat format for easy reading.",
    inputSchema: {
      index: z.string().describe("Index name"),
      include_defaults: z
        .boolean()
        .default(true)
        .describe("Include default values"),
    },
  }, async ({ index, include_defaults }) => {
    const qs = include_defaults
      ? "?include_defaults=true&flat_settings=true"
      : "?flat_settings=true";
    const result = await esFetch(
      "GET",
      `/${encodeURIComponent(index)}/_settings${qs}`,
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  });
}
