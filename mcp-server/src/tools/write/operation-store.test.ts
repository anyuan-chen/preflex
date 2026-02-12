import { describe, it, expect, beforeEach } from "vitest";
import {
  storePendingOperation,
  getPendingOperation,
  removePendingOperation,
  listPendingOperations,
} from "./operation-store.js";

describe("operation-store", () => {
  // Clear the store between tests by removing all operations
  beforeEach(() => {
    for (const op of listPendingOperations()) {
      removePendingOperation(op.id);
    }
  });

  describe("storePendingOperation", () => {
    it("returns an 8-character ID", () => {
      const id = storePendingOperation("reindex", { source: "a" }, { preview: true });
      expect(id).toHaveLength(8);
    });

    it("stores the operation retrievably", () => {
      const id = storePendingOperation(
        "update_settings",
        { index: "test", settings: { "index.number_of_replicas": 0 } },
        { current: {}, proposed: {} },
      );

      const op = getPendingOperation(id);
      expect(op).toBeDefined();
      expect(op!.action).toBe("update_settings");
      expect(op!.params).toEqual({
        index: "test",
        settings: { "index.number_of_replicas": 0 },
      });
    });

    it("sets created_at to an ISO timestamp", () => {
      const before = new Date().toISOString();
      const id = storePendingOperation("reindex", {}, {});
      const after = new Date().toISOString();

      const op = getPendingOperation(id);
      expect(op!.created_at >= before).toBe(true);
      expect(op!.created_at <= after).toBe(true);
    });

    it("generates unique IDs for different operations", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        ids.add(storePendingOperation("reindex", { i }, {}));
      }
      expect(ids.size).toBe(50);
    });
  });

  describe("getPendingOperation", () => {
    it("returns undefined for nonexistent ID", () => {
      expect(getPendingOperation("nonexistent")).toBeUndefined();
    });

    it("returns the full operation object", () => {
      const id = storePendingOperation(
        "shrink_index",
        { source: "big", target: "small", shards: 1 },
        { doc_count: 5000 },
      );

      const op = getPendingOperation(id);
      expect(op).toMatchObject({
        id,
        action: "shrink_index",
        params: { source: "big", target: "small", shards: 1 },
        preview: { doc_count: 5000 },
      });
    });
  });

  describe("removePendingOperation", () => {
    it("returns true when removing an existing operation", () => {
      const id = storePendingOperation("reindex", {}, {});
      expect(removePendingOperation(id)).toBe(true);
    });

    it("returns false when removing a nonexistent operation", () => {
      expect(removePendingOperation("nonexistent")).toBe(false);
    });

    it("makes the operation no longer retrievable", () => {
      const id = storePendingOperation("reindex", {}, {});
      removePendingOperation(id);
      expect(getPendingOperation(id)).toBeUndefined();
    });

    it("can only remove once", () => {
      const id = storePendingOperation("reindex", {}, {});
      expect(removePendingOperation(id)).toBe(true);
      expect(removePendingOperation(id)).toBe(false);
    });
  });

  describe("listPendingOperations", () => {
    it("returns empty array when store is empty", () => {
      expect(listPendingOperations()).toEqual([]);
    });

    it("returns all stored operations", () => {
      storePendingOperation("reindex", { a: 1 }, {});
      storePendingOperation("update_settings", { b: 2 }, {});
      storePendingOperation("manage_aliases", { c: 3 }, {});

      const ops = listPendingOperations();
      expect(ops).toHaveLength(3);

      const actions = ops.map((o) => o.action).sort();
      expect(actions).toEqual(["manage_aliases", "reindex", "update_settings"]);
    });

    it("reflects removals", () => {
      const id1 = storePendingOperation("reindex", {}, {});
      storePendingOperation("shrink_index", {}, {});

      removePendingOperation(id1);

      const ops = listPendingOperations();
      expect(ops).toHaveLength(1);
      expect(ops[0].action).toBe("shrink_index");
    });
  });
});
