import * as z from "zod/v4";
import { esFetch } from "../../es-client.js";
export function registerIndexInfo(server) {
    server.registerTool("index_info", {
        title: "Index Info",
        description: "List indices with health, shard counts, doc counts, and sizes. " +
            "One row per index. Use pattern to filter (e.g. 'sb-*' or specific index name).",
        inputSchema: {
            pattern: z
                .string()
                .default("*")
                .describe("Index name or pattern (e.g. 'sb-*', 'my-index')"),
        },
    }, async ({ pattern }) => {
        const result = await esFetch("GET", `/_cat/indices/${encodeURIComponent(pattern)}?format=json&h=index,health,status,pri,rep,docs.count,docs.deleted,store.size,pri.store.size&s=index`);
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    });
}
//# sourceMappingURL=index-info.js.map