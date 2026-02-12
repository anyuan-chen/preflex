import * as z from "zod/v4";
import { getPendingOperation, removePendingOperation, listPendingOperations, } from "./operation-store.js";
export function registerCancelOperation(server) {
    server.registerTool("cancel_operation", {
        title: "Cancel Operation",
        description: "Discard a pending HITL operation without executing it. " +
            "Use this after reviewing a preview if you decide not to proceed.",
        inputSchema: {
            operation_id: z.string().describe("The operation_id from the preview response"),
        },
    }, async ({ operation_id }) => {
        const op = getPendingOperation(operation_id);
        if (!op) {
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            success: false,
                            error: `No pending operation found with id "${operation_id}".`,
                        }, null, 2),
                    }],
                isError: true,
            };
        }
        removePendingOperation(operation_id);
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        cancelled: true,
                        operation_id,
                        action: op.action,
                        message: "Operation discarded. No changes were made.",
                    }, null, 2),
                }],
        };
    });
    server.registerTool("list_pending_operations", {
        title: "List Pending Operations",
        description: "List all pending HITL operations awaiting confirmation or cancellation.",
        inputSchema: {},
    }, async () => {
        const ops = listPendingOperations();
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        count: ops.length,
                        operations: ops.map((op) => ({
                            operation_id: op.id,
                            action: op.action,
                            created_at: op.created_at,
                            preview: op.preview,
                        })),
                    }, null, 2),
                }],
        };
    });
}
//# sourceMappingURL=cancel-operation.js.map