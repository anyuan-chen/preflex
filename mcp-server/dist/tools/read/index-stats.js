import * as z from "zod/v4";
import { esFetch } from "../../es-client.js";
export function registerIndexStats(server) {
    server.registerTool("index_stats", {
        title: "Index Stats",
        description: "Live performance metrics for an index: search query count/latency, " +
            "indexing rate, fielddata evictions, query cache hit ratios, segment counts, store size.",
        inputSchema: {
            index: z.string().describe("Index name"),
        },
    }, async ({ index }) => {
        const result = await esFetch("GET", `/${encodeURIComponent(index)}/_stats/search,indexing,fielddata,query_cache,segments,store`);
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    });
}
//# sourceMappingURL=index-stats.js.map