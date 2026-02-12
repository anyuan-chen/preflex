import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { esFetch } from "../../es-client.js";
import {
  getPendingOperation,
  removePendingOperation,
  type PendingOperation,
} from "./operation-store.js";

/**
 * Execute a pending HITL operation.
 * This duplicates the execution logic from each write tool's non-HITL path.
 * The tradeoff is some duplication vs. tight coupling; keeping it explicit.
 */
async function executeOperation(op: PendingOperation): Promise<Record<string, unknown>> {
  const p = op.params;

  switch (op.action) {
    case "update_settings": {
      const index = p.index as string;
      const settings = p.settings as Record<string, unknown>;
      const before = await esFetch<Record<string, unknown>>(
        "GET",
        `/${encodeURIComponent(index)}/_settings?flat_settings=true`,
      );
      await esFetch("PUT", `/${encodeURIComponent(index)}/_settings`, settings);
      const after = await esFetch<Record<string, unknown>>(
        "GET",
        `/${encodeURIComponent(index)}/_settings?flat_settings=true`,
      );
      const health = await esFetch<Record<string, unknown>>(
        "GET",
        `/_cluster/health/${encodeURIComponent(index)}`,
      );
      return {
        success: true,
        action: "update_settings",
        index,
        applied_settings: settings,
        before_settings: before,
        after_settings: after,
        cluster_health: health,
      };
    }

    case "reindex": {
      const source = p.source_index as string;
      const target = p.target_index as string;
      const mappings = p.target_mappings as Record<string, unknown>;
      const settings = p.target_settings as Record<string, unknown> | undefined;

      const sourceCount = await esFetch<{ count: number }>("GET", `/${encodeURIComponent(source)}/_count`);

      const createBody: Record<string, unknown> = { mappings: { properties: mappings } };
      if (settings) createBody.settings = settings;
      await esFetch("PUT", `/${encodeURIComponent(target)}`, createBody);

      const reindexResult = await esFetch<Record<string, unknown>>("POST", "/_reindex", {
        source: { index: source },
        dest: { index: target },
      });

      const targetCount = await esFetch<{ count: number }>("GET", `/${encodeURIComponent(target)}/_count`);
      const targetMapping = await esFetch("GET", `/${encodeURIComponent(target)}/_mapping`);
      const failures = (reindexResult.failures as unknown[]) ?? [];
      const docMatch = targetCount.count === sourceCount.count;

      return {
        success: failures.length === 0 && docMatch,
        action: "reindex",
        source_index: source,
        target_index: target,
        source_count: sourceCount.count,
        target_count: targetCount.count,
        reindex_response: reindexResult,
        target_mapping: targetMapping,
      };
    }

    case "shrink_index": {
      const source = p.source_index as string;
      const target = p.target_index as string;
      const shards = p.target_shards as number;

      const sourceCount = await esFetch<{ count: number }>("GET", `/${encodeURIComponent(source)}/_count`);
      const nodesResp = await esFetch<{ nodes: Record<string, { name: string }> }>("GET", "/_nodes/_all/name");
      const nodeNames = Object.values(nodesResp.nodes).map((n) => n.name);
      const targetNode = nodeNames[0];

      await esFetch("PUT", `/${encodeURIComponent(source)}/_settings`, {
        "index.number_of_replicas": 0,
        "index.routing.allocation.require._name": targetNode,
        "index.blocks.write": true,
      });

      // Wait for green
      const start = Date.now();
      let ready = false;
      while (Date.now() - start < 30000) {
        try {
          const h = await esFetch<{ status: string }>(
            "GET",
            `/_cluster/health/${encodeURIComponent(source)}?wait_for_status=green&timeout=5s`,
          );
          if (h.status === "green") { ready = true; break; }
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (!ready) {
        await esFetch("PUT", `/${encodeURIComponent(source)}/_settings`, {
          "index.blocks.write": null,
          "index.routing.allocation.require._name": null,
        });
        throw new Error("Timed out waiting for shard relocation");
      }

      await esFetch(
        "POST",
        `/${encodeURIComponent(source)}/_shrink/${encodeURIComponent(target)}`,
        {
          settings: {
            "index.number_of_shards": shards,
            "index.routing.allocation.require._name": null,
            "index.blocks.write": null,
            "index.number_of_replicas": 0,
          },
        },
      );

      // Wait for target green
      const start2 = Date.now();
      while (Date.now() - start2 < 60000) {
        try {
          const h = await esFetch<{ status: string }>(
            "GET",
            `/_cluster/health/${encodeURIComponent(target)}?wait_for_status=green&timeout=5s`,
          );
          if (h.status === "green") break;
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 2000));
      }

      const targetCount = await esFetch<{ count: number }>("GET", `/${encodeURIComponent(target)}/_count`);
      const docMatch = targetCount.count === sourceCount.count;

      return {
        success: docMatch,
        action: "shrink_index",
        source_index: source,
        target_index: target,
        target_shards: shards,
        source_count: sourceCount.count,
        target_count: targetCount.count,
        doc_count_match: docMatch,
      };
    }

    case "manage_aliases": {
      const actions = p.actions as Array<{ action: string; index: string; alias: string }>;
      const esActions = actions.map((a) => ({
        [a.action]: { index: a.index, alias: a.alias },
      }));
      const result = await esFetch("POST", "/_aliases", { actions: esActions });

      const aliasNames = [...new Set(actions.filter((a) => a.action === "add").map((a) => a.alias))];
      const verification: Record<string, unknown> = {};
      for (const alias of aliasNames) {
        try {
          verification[alias] = await esFetch("GET", `/_alias/${encodeURIComponent(alias)}`);
        } catch {
          verification[alias] = "not found";
        }
      }

      return {
        success: true,
        action: "manage_aliases",
        applied_actions: actions,
        result,
        alias_verification: verification,
      };
    }

    default:
      throw new Error(`Unknown operation action: ${op.action}`);
  }
}

export function registerConfirmOperation(server: McpServer): void {
  server.registerTool("confirm_operation", {
    title: "Confirm Operation",
    description:
      "Execute a pending HITL operation by its operation_id. " +
      "Call this after reviewing the preview returned by a write tool in HITL mode.",
    inputSchema: {
      operation_id: z.string().describe("The operation_id from the preview response"),
    },
  }, async ({ operation_id }) => {
    const op = getPendingOperation(operation_id);
    if (!op) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            error: `No pending operation found with id "${operation_id}". It may have been already confirmed or cancelled.`,
          }, null, 2),
        }],
        isError: true,
      };
    }

    try {
      const result = await executeOperation(op);
      removePendingOperation(operation_id);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            confirmed: true,
            operation_id,
            ...result,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            confirmed: false,
            operation_id,
            error: err instanceof Error ? err.message : String(err),
            message: "Operation failed. The pending operation has been preserved — you can retry or cancel it.",
          }, null, 2),
        }],
        isError: true,
      };
    }
  });
}
