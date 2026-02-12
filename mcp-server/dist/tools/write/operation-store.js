/**
 * In-memory store for pending HITL operations.
 * Operations are stored when a write tool is called in HITL mode,
 * then executed or discarded via confirm_operation / cancel_operation.
 */
import { randomUUID } from "node:crypto";
const store = new Map();
/** Create a pending operation and return its ID. */
export function storePendingOperation(action, params, preview) {
    const id = randomUUID().slice(0, 8);
    store.set(id, {
        id,
        action,
        created_at: new Date().toISOString(),
        params,
        preview,
    });
    return id;
}
/** Retrieve a pending operation by ID. Returns undefined if not found. */
export function getPendingOperation(id) {
    return store.get(id);
}
/** Remove a pending operation (after confirm or cancel). */
export function removePendingOperation(id) {
    return store.delete(id);
}
/** List all pending operations. */
export function listPendingOperations() {
    return Array.from(store.values());
}
//# sourceMappingURL=operation-store.js.map