import * as z from "zod/v4";
import { esFetch } from "../../es-client.js";
import { config } from "../../config.js";
import { storePendingOperation } from "./operation-store.js";
export function registerReindex(server) {
    server.registerTool("reindex", {
        title: "Reindex",
        description: "Copy data from a source index to a new target index with different mappings. " +
            "Creates the target index first, then copies all documents. " +
            "Verifies doc count matches after completion. Source index is never modified.",
        inputSchema: {
            source_index: z.string().describe("Source index to copy from"),
            target_index: z.string().describe("Target index name to create"),
            target_mappings: z
                .record(z.string(), z.any())
                .describe("Mapping properties for the target index (the 'properties' object)"),
            target_settings: z
                .record(z.string(), z.any())
                .optional()
                .describe("Optional settings for the target index"),
        },
    }, async ({ source_index, target_index, target_mappings, target_settings }) => {
        if (config.verifyMode === "hitl") {
            const sourceMapping = await esFetch("GET", `/${encodeURIComponent(source_index)}/_mapping`);
            const sourceCount = await esFetch("GET", `/${encodeURIComponent(source_index)}/_count`);
            const preview = {
                action: "reindex",
                source_index,
                target_index,
                source_doc_count: sourceCount.count,
                current_mappings: sourceMapping,
                proposed_mappings: target_mappings,
                proposed_settings: target_settings,
            };
            const opId = storePendingOperation("reindex", { source_index, target_index, target_mappings, target_settings }, preview);
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            mode: "preview",
                            operation_id: opId,
                            ...preview,
                            message: `HITL mode: review the proposed reindex. Use confirm_operation("${opId}") to apply or cancel_operation("${opId}") to discard.`,
                        }, null, 2),
                    }],
            };
        }
        // 1. Get source doc count for verification
        const sourceCount = await esFetch("GET", `/${encodeURIComponent(source_index)}/_count`);
        // 2. Create target index with new mappings
        const createBody = {
            mappings: { properties: target_mappings },
        };
        if (target_settings) {
            createBody.settings = target_settings;
        }
        try {
            await esFetch("PUT", `/${encodeURIComponent(target_index)}`, createBody);
        }
        catch (err) {
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            success: false,
                            step: "create_target_index",
                            error: err instanceof Error ? err.message : String(err),
                        }, null, 2),
                    }],
                isError: true,
            };
        }
        // 3. Execute reindex
        let reindexResult;
        try {
            reindexResult = await esFetch("POST", "/_reindex", {
                source: { index: source_index },
                dest: { index: target_index },
            });
        }
        catch (err) {
            // Clean up: delete the target index
            try {
                await esFetch("DELETE", `/${encodeURIComponent(target_index)}`);
            }
            catch { /* ignore */ }
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            success: false,
                            step: "reindex",
                            error: err instanceof Error ? err.message : String(err),
                            rollback: "Target index deleted",
                        }, null, 2),
                    }],
                isError: true,
            };
        }
        // 4. Verify
        const targetCount = await esFetch("GET", `/${encodeURIComponent(target_index)}/_count`);
        const targetMapping = await esFetch("GET", `/${encodeURIComponent(target_index)}/_mapping`);
        const failures = reindexResult.failures ?? [];
        const docCountMatch = targetCount.count === sourceCount.count;
        if (failures.length > 0 || !docCountMatch) {
            // Verification failed
            const details = [];
            if (failures.length > 0)
                details.push(`${failures.length} reindex failures`);
            if (!docCountMatch)
                details.push(`Doc count mismatch: source=${sourceCount.count}, target=${targetCount.count}`);
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            success: false,
                            step: "verification",
                            details,
                            reindex_response: reindexResult,
                            source_count: sourceCount.count,
                            target_count: targetCount.count,
                            message: "Reindex completed but verification failed. Target index preserved for inspection.",
                        }, null, 2),
                    }],
                isError: true,
            };
        }
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        success: true,
                        action: "reindex",
                        source_index,
                        target_index,
                        source_count: sourceCount.count,
                        target_count: targetCount.count,
                        reindex_response: reindexResult,
                        target_mapping: targetMapping,
                        message: "Reindex completed and verified. Use manage_aliases to swap the alias if needed.",
                    }, null, 2),
                }],
        };
    });
}
//# sourceMappingURL=reindex.js.map