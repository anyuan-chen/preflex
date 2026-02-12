import * as z from "zod/v4";
import { esFetch } from "../../es-client.js";
export function registerIndexMapping(server) {
    server.registerTool("index_mapping", {
        title: "Index Mapping",
        description: "Get the full field type definitions for an index. " +
            "Shows every field's type (text, keyword, date, long, etc.). " +
            "Primary tool for diagnosing bad-mapping problems.",
        inputSchema: {
            index: z.string().describe("Index name (required)"),
        },
    }, async ({ index }) => {
        const result = await esFetch("GET", `/${encodeURIComponent(index)}/_mapping`);
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    });
}
//# sourceMappingURL=index-mapping.js.map