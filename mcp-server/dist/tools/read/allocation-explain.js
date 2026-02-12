import * as z from "zod/v4";
import { esFetch } from "../../es-client.js";
export function registerAllocationExplain(server) {
    server.registerTool("allocation_explain", {
        title: "Allocation Explain",
        description: "Explain why a shard is unassigned. Returns the allocation decider that blocked it. " +
            "Call with no arguments to explain the first unassigned shard, or specify index/shard/primary.",
        inputSchema: {
            index: z.string().optional().describe("Index name (optional — omit to explain first unassigned shard)"),
            shard: z.number().int().optional().describe("Shard number"),
            primary: z.boolean().optional().describe("Whether to explain the primary (true) or replica (false)"),
        },
    }, async ({ index, shard, primary }) => {
        const body = {};
        if (index !== undefined)
            body.index = index;
        if (shard !== undefined)
            body.shard = shard;
        if (primary !== undefined)
            body.primary = primary;
        try {
            const result = await esFetch("POST", "/_cluster/allocation/explain", Object.keys(body).length > 0 ? body : undefined);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
        catch (err) {
            // ES returns 400 when there are no unassigned shards
            return {
                content: [{
                        type: "text",
                        text: `No unassigned shards to explain. ${err instanceof Error ? err.message : String(err)}`,
                    }],
            };
        }
    });
}
//# sourceMappingURL=allocation-explain.js.map