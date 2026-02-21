/**
 * Slack notifications — posts monitor events to a Slack channel.
 *
 * Uses threaded messages: anomaly detection creates a parent message,
 * subsequent tool calls and invocation results reply in the thread.
 */

import { config } from "../config.js";
import type { Anomaly } from "./anomaly.js";
import type { InvocationResult } from "./invoke.js";

// ---------------------------------------------------------------------------
// Slack API
// ---------------------------------------------------------------------------

interface SlackPostResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

async function postMessage(
  text: string,
  threadTs?: string,
): Promise<SlackPostResult> {
  if (!config.slackToken || !config.slackChannel) {
    return { ok: false, error: "not configured" };
  }

  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.slackToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: config.slackChannel,
        text,
        thread_ts: threadTs,
        unfurl_links: false,
      }),
    });
    return (await res.json()) as SlackPostResult;
  } catch (err) {
    console.error("[slack] post failed:", err);
    return { ok: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Thread tracking — anomaly → thread_ts
// ---------------------------------------------------------------------------

let activeThread: string | undefined;
let threadToolCalls: { tool: string; category: "read" | "write" }[] = [];

// ---------------------------------------------------------------------------
// Public API — called from index.ts monitor listener
// ---------------------------------------------------------------------------

export function isSlackConfigured(): boolean {
  return !!(config.slackToken && config.slackChannel);
}

export async function slackAnomalyDetected(anomalies: Anomaly[]): Promise<void> {
  const descriptions = anomalies.map((a) => {
    const severity = a.severity === "critical" ? "Critical" : "Warning";
    const idx = a.index ? ` on \`${a.index}\`` : "";
    return `${severity}: ${a.description}${idx} (rule: ${a.rule})`;
  });

  const text = `:rotating_light: *Anomaly detected*\n\n${descriptions.join("\n")}`;

  const res = await postMessage(text);

  if (res.ok && res.ts) {
    activeThread = res.ts;
  }
}

export async function slackToolCall(
  tool: string,
  category: "read" | "write",
  args?: Record<string, unknown>,
): Promise<void> {
  threadToolCalls.push({ tool, category });
  await postMessage(describeToolCall(tool, category, args), activeThread);
}

function describeToolCall(
  tool: string,
  category: "read" | "write",
  args?: Record<string, unknown>,
): string {
  const idx = args?.index ?? args?.pattern ?? args?.source_index;
  const target = args?.target_index;

  switch (tool) {
    case "cluster_health":
      return "Checking cluster health";
    case "node_stats":
      return "Pulling node-level CPU, heap, and thread pool stats";
    case "allocation_explain":
      return idx ? `Explaining shard allocation for \`${idx}\`` : "Explaining unassigned shard allocation";
    case "index_mapping":
      return `Inspecting field mappings on \`${idx}\``;
    case "index_stats":
      return `Pulling query volume and error counts for \`${idx}\``;
    case "index_settings":
      return `Checking index settings on \`${idx}\``;
    case "index_info":
      return `Listing indices matching \`${idx ?? "*"}\``;
    case "shard_info":
      return `Checking shard layout for \`${idx ?? "*"}\``;
    case "field_caps":
      return `Checking field types on \`${idx}\``;
    case "query_profile":
      return `Profiling query performance on \`${idx}\``;
    case "running_tasks":
      return "Listing running cluster tasks";
    case "reindex":
      return `Reindexing \`${idx}\` → \`${target}\` with corrected mappings`;
    case "shrink_index":
      return `Shrinking \`${idx}\` → \`${target}\` (${args?.target_shards ?? "?"} shards)`;
    case "manage_aliases":
      return formatAliasActions(args?.actions);
    case "update_settings":
      return formatSettingsUpdate(idx as string | undefined, args?.settings);
    case "cancel_task":
      return `Cancelling task \`${args?.task_id}\``;
    default:
      return category === "write" ? `Applying \`${tool}\`` : `Running \`${tool}\``;
  }
}

function formatAliasActions(actions: unknown): string {
  if (!Array.isArray(actions) || actions.length === 0) return "Updating aliases";
  const parts = actions.map((a: Record<string, string>) => {
    if (a.action === "add") return `pointing \`${a.alias}\` → \`${a.index}\``;
    return `removing \`${a.alias}\` from \`${a.index}\``;
  });
  return `Swapping aliases: ${parts.join(", ")}`;
}

function formatSettingsUpdate(index: string | undefined, settings: unknown): string {
  if (!index || !settings || typeof settings !== "object") return `Updating settings on \`${index}\``;
  const keys = Object.keys(settings as Record<string, unknown>);
  const short = keys.map((k) => k.replace("index.", "")).join(", ");
  return `Updating \`${short}\` on \`${index}\``;
}

export async function slackInvocationComplete(
  result: InvocationResult,
  anomalies?: Anomaly[],
  startTimestamp?: number,
): Promise<void> {
  const ruleName = anomalies?.[0]?.rule ?? "unknown";

  // Root cause from agent response
  const rootCause = result.agentResponse
    ? result.agentResponse.slice(0, 300) + (result.agentResponse.length > 300 ? "..." : "")
    : result.error ?? "No details available";

  // Summarize tool calls
  const reads = threadToolCalls.filter((t) => t.category === "read");
  const writes = threadToolCalls.filter((t) => t.category === "write");
  const readNames = [...new Set(reads.map((t) => t.tool))];
  const writeNames = [...new Set(writes.map((t) => t.tool))];

  const parts: string[] = [];
  if (readNames.length > 0) {
    parts.push(`${reads.length} diagnostic check${reads.length === 1 ? "" : "s"} (${readNames.map((n) => `\`${n}\``).join(", ")})`);
  }
  if (writeNames.length > 0) {
    parts.push(`${writes.length} remediation${writes.length === 1 ? "" : "s"} (${writeNames.map((n) => `\`${n}\``).join(", ")})`);
  }
  const actionsSummary = parts.length > 0 ? parts.join(", ") : "no tool calls recorded";

  // Affected indices
  const uniqueIndices = [...new Set(
    anomalies?.map((a) => a.index).filter((idx): idx is string => !!idx),
  )];
  const indicesText = uniqueIndices.length > 0
    ? uniqueIndices.map((i) => `\`${i}\``).join(", ")
    : "none";

  // Time to resolution
  let ttrText = "unknown";
  if (startTimestamp) {
    const elapsed = Math.round((Date.now() - startTimestamp) / 1000);
    ttrText = elapsed >= 60
      ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
      : `${elapsed}s`;
  }

  const icon = result.success ? ":white_check_mark:" : ":x:";
  const status = result.success ? "Incident resolved" : "Incident failed";

  const text = [
    `${icon} *${status}* — \`${ruleName}\``,
    ``,
    rootCause,
    ``,
    `Ran ${actionsSummary} against ${indicesText}. Resolved in ${ttrText}.`,
  ].join("\n");

  await postMessage(text, activeThread);

  activeThread = undefined;
  threadToolCalls = [];
}
