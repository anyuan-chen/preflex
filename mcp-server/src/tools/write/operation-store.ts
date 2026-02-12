/**
 * In-memory store for pending HITL operations.
 * Operations are stored when a write tool is called in HITL mode,
 * then executed or discarded via confirm_operation / cancel_operation.
 */

import { randomUUID } from "node:crypto";

export type OperationAction =
  | "update_settings"
  | "reindex"
  | "shrink_index"
  | "manage_aliases";

export interface PendingOperation {
  id: string;
  action: OperationAction;
  created_at: string;
  params: Record<string, unknown>;
  preview: Record<string, unknown>;
}

const store = new Map<string, PendingOperation>();

/** Create a pending operation and return its ID. */
export function storePendingOperation(
  action: OperationAction,
  params: Record<string, unknown>,
  preview: Record<string, unknown>,
): string {
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
export function getPendingOperation(id: string): PendingOperation | undefined {
  return store.get(id);
}

/** Remove a pending operation (after confirm or cancel). */
export function removePendingOperation(id: string): boolean {
  return store.delete(id);
}

/** List all pending operations. */
export function listPendingOperations(): PendingOperation[] {
  return Array.from(store.values());
}
