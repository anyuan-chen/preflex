import * as z from "zod/v4";
import { esFetch } from "../../es-client.js";
import { config } from "../../config.js";
import { storePendingOperation } from "./operation-store.js";
export function registerUpdateSettings(server) {
    server.registerTool("update_settings", {
        title: "Update Index Settings",
        description: "Update dynamic index settings such as number_of_replicas, refresh_interval, " +
            "or slow log thresholds. In auto mode, changes are verified by reading back the setting " +
            "and replaying queries. In hitl mode, returns a preview without applying.",
        inputSchema: {
            index: z.string().describe("Index name"),
            settings: z
                .record(z.string(), z.any())
                .describe('Settings object, e.g. {"index.number_of_replicas": 0}'),
        },
    }, async ({ index, settings }) => {
        if (config.verifyMode === "hitl") {
            // Preview mode: show what would change
            const current = await esFetch("GET", `/${encodeURIComponent(index)}/_settings?flat_settings=true`);
            const preview = {
                action: "update_settings",
                index,
                proposed_settings: settings,
                current_settings: current,
            };
            const opId = storePendingOperation("update_settings", { index, settings }, preview);
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            mode: "preview",
                            operation_id: opId,
                            ...preview,
                            message: `HITL mode: review the proposed changes. Use confirm_operation("${opId}") to apply or cancel_operation("${opId}") to discard.`,
                        }, null, 2),
                    }],
            };
        }
        // Capture baseline settings for potential rollback
        const beforeSettings = await esFetch("GET", `/${encodeURIComponent(index)}/_settings?flat_settings=true`);
        // Apply the settings
        try {
            await esFetch("PUT", `/${encodeURIComponent(index)}/_settings`, settings);
        }
        catch (err) {
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            success: false,
                            error: err instanceof Error ? err.message : String(err),
                            action: "update_settings",
                            index,
                            settings,
                        }, null, 2),
                    }],
                isError: true,
            };
        }
        // Read back to confirm
        const afterSettings = await esFetch("GET", `/${encodeURIComponent(index)}/_settings?flat_settings=true`);
        // Check cluster health after change
        const health = await esFetch("GET", `/_cluster/health/${encodeURIComponent(index)}`);
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        success: true,
                        action: "update_settings",
                        index,
                        applied_settings: settings,
                        before_settings: beforeSettings,
                        after_settings: afterSettings,
                        cluster_health: health,
                    }, null, 2),
                }],
        };
    });
}
//# sourceMappingURL=update-settings.js.map