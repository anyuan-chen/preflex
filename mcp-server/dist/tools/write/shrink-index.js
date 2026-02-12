import * as z from "zod/v4";
import { esFetch } from "../../es-client.js";
import { config } from "../../config.js";
import { storePendingOperation } from "./operation-store.js";
async function waitForGreen(index, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const health = await esFetch("GET", `/_cluster/health/${encodeURIComponent(index)}?wait_for_status=green&timeout=5s`);
            if (health.status === "green")
                return true;
        }
        catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
}
export function registerShrinkIndex(server) {
    server.registerTool("shrink_index", {
        title: "Shrink Index",
        description: "Reduce the number of primary shards in an index. Creates a new target index with fewer shards. " +
            "Automatically handles prerequisites: blocks writes, allocates to single node, waits for relocation. " +
            "Verifies doc count matches after shrink.",
        inputSchema: {
            source_index: z.string().describe("Index to shrink"),
            target_index: z.string().describe("Target index name"),
            target_shards: z.number().int().positive().describe("Target number of primary shards (must be a factor of current count)"),
        },
    }, async ({ source_index, target_index, target_shards }) => {
        if (config.verifyMode === "hitl") {
            const settings = await esFetch("GET", `/${encodeURIComponent(source_index)}/_settings?flat_settings=true`);
            const count = await esFetch("GET", `/${encodeURIComponent(source_index)}/_count`);
            const preview = {
                action: "shrink_index",
                source_index,
                target_index,
                target_shards,
                current_settings: settings,
                doc_count: count.count,
            };
            const opId = storePendingOperation("shrink_index", { source_index, target_index, target_shards }, preview);
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            mode: "preview",
                            operation_id: opId,
                            ...preview,
                            message: `HITL mode: review the proposed shrink. Use confirm_operation("${opId}") to apply or cancel_operation("${opId}") to discard.`,
                        }, null, 2),
                    }],
            };
        }
        // 1. Get source doc count and node info
        const sourceCount = await esFetch("GET", `/${encodeURIComponent(source_index)}/_count`);
        // Get a data node name for allocation
        const nodesResp = await esFetch("GET", "/_nodes/_all/name");
        const nodeNames = Object.values(nodesResp.nodes).map((n) => n.name);
        if (nodeNames.length === 0) {
            return {
                content: [{ type: "text", text: JSON.stringify({ success: false, error: "No nodes found" }, null, 2) }],
                isError: true,
            };
        }
        const targetNode = nodeNames[0];
        // 2. Prepare: block writes + allocate to single node
        try {
            await esFetch("PUT", `/${encodeURIComponent(source_index)}/_settings`, {
                "index.number_of_replicas": 0,
                "index.routing.allocation.require._name": targetNode,
                "index.blocks.write": true,
            });
        }
        catch (err) {
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            success: false,
                            step: "prepare",
                            error: err instanceof Error ? err.message : String(err),
                        }, null, 2),
                    }],
                isError: true,
            };
        }
        // 3. Wait for all shards on target node (green health)
        const ready = await waitForGreen(source_index);
        if (!ready) {
            // Rollback preparation
            await esFetch("PUT", `/${encodeURIComponent(source_index)}/_settings`, {
                "index.blocks.write": null,
                "index.routing.allocation.require._name": null,
            });
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            success: false,
                            step: "wait_for_relocation",
                            error: "Timed out waiting for shard relocation",
                        }, null, 2),
                    }],
                isError: true,
            };
        }
        // 4. Execute shrink
        try {
            await esFetch("POST", `/${encodeURIComponent(source_index)}/_shrink/${encodeURIComponent(target_index)}`, {
                settings: {
                    "index.number_of_shards": target_shards,
                    "index.routing.allocation.require._name": null,
                    "index.blocks.write": null,
                    "index.number_of_replicas": 0,
                },
            });
        }
        catch (err) {
            // Rollback: unblock source
            await esFetch("PUT", `/${encodeURIComponent(source_index)}/_settings`, {
                "index.blocks.write": null,
                "index.routing.allocation.require._name": null,
            });
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            success: false,
                            step: "shrink",
                            error: err instanceof Error ? err.message : String(err),
                        }, null, 2),
                    }],
                isError: true,
            };
        }
        // 5. Wait for target to be green
        await waitForGreen(target_index, 60000);
        // 6. Verify doc count
        const targetCount = await esFetch("GET", `/${encodeURIComponent(target_index)}/_count`);
        const docCountMatch = targetCount.count === sourceCount.count;
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        success: docCountMatch,
                        action: "shrink_index",
                        source_index,
                        target_index,
                        target_shards,
                        source_count: sourceCount.count,
                        target_count: targetCount.count,
                        doc_count_match: docCountMatch,
                        message: docCountMatch
                            ? "Shrink completed and verified. Source index still exists (write-blocked). Use manage_aliases to swap if needed."
                            : "Shrink completed but doc count mismatch. Investigate before proceeding.",
                    }, null, 2),
                }],
        };
    });
}
//# sourceMappingURL=shrink-index.js.map