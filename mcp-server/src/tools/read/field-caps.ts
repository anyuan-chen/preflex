import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { esFetch } from "../../es-client.js";

export function registerFieldCaps(server: McpServer): void {
  server.registerTool("field_caps", {
    title: "Field Capabilities",
    description:
      "Per-field capabilities: type, searchable, aggregatable flags. " +
      "Detects cross-index type conflicts. Useful alongside index_mapping " +
      "to understand what operations are possible on each field.",
    inputSchema: {
      index: z.string().describe("Index name or pattern"),
    },
  }, async ({ index }) => {
    const result = await esFetch(
      "GET",
      `/${encodeURIComponent(index)}/_field_caps?fields=*`,
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  });
}
