/**
 * In-memory store for pending HITL operations.
 * Operations are stored when a write tool is called in HITL mode,
 * then executed or discarded via confirm_operation / cancel_operation.
 */
export type OperationAction = "update_settings" | "reindex" | "shrink_index" | "manage_aliases";
export interface PendingOperation {
    id: string;
    action: OperationAction;
    created_at: string;
    params: Record<string, unknown>;
    preview: Record<string, unknown>;
}
/** Create a pending operation and return its ID. */
export declare function storePendingOperation(action: OperationAction, params: Record<string, unknown>, preview: Record<string, unknown>): string;
/** Retrieve a pending operation by ID. Returns undefined if not found. */
export declare function getPendingOperation(id: string): PendingOperation | undefined;
/** Remove a pending operation (after confirm or cancel). */
export declare function removePendingOperation(id: string): boolean;
/** List all pending operations. */
export declare function listPendingOperations(): PendingOperation[];
