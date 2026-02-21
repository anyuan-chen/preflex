/**
 * Agent invocation — sends anomaly digests to the Elastic Agent Builder
 * via the Kibana converse API.
 *
 * When anomalies fire, the monitor builds a digest and POSTs it to
 * the existing Agent Builder agent. The agent (with its LLM + MCP tools)
 * diagnoses and acts autonomously.
 */

import { config } from "../config.js";
import type { Anomaly } from "./anomaly.js";
import type { Window } from "./window.js";
import { renderDigest } from "./digest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InvocationResult {
  success: boolean;
  conversationId?: string;
  agentResponse?: string;
  error?: string;
}

export interface InvocationRecord {
  timestamp: number;
  anomalies: Anomaly[];
  digest: string;
  result: InvocationResult;
}

// ---------------------------------------------------------------------------
// History — recent invocations (in-memory ring)
// ---------------------------------------------------------------------------

const MAX_HISTORY = 50;
const history: InvocationRecord[] = [];

export function getInvocationHistory(): readonly InvocationRecord[] {
  return history;
}

// ---------------------------------------------------------------------------
// Build the message sent to the agent
// ---------------------------------------------------------------------------

export function buildAgentMessage(
  anomalies: Anomaly[],
  windows: Window[],
): string {
  const lines: string[] = [];

  // Anomaly summary
  lines.push("ANOMALY DETECTED:");
  for (const a of anomalies) {
    const tag = a.severity === "critical" ? "[CRITICAL]" : "[WARNING]";
    lines.push(`  ${tag} ${a.description}`);
  }

  lines.push("");
  lines.push(renderDigest(windows));

  lines.push("");
  lines.push("Investigate and fix if possible. Check cluster capacity before heavy operations.");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Invoke the Agent Builder
// ---------------------------------------------------------------------------

export async function invokeAgent(
  anomalies: Anomaly[],
  windows: Window[],
): Promise<InvocationResult> {
  const digest = buildAgentMessage(anomalies, windows);

  const record: InvocationRecord = {
    timestamp: Date.now(),
    anomalies,
    digest,
    result: { success: false },
  };

  try {
    const result = await callConverseApi(digest);
    record.result = result;
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    record.result = { success: false, error };
    return record.result;
  } finally {
    history.push(record);
    if (history.length > MAX_HISTORY) history.shift();
  }
}

async function callConverseApi(message: string): Promise<InvocationResult> {
  const url = `${config.kibanaUrl}/api/agent_builder/converse`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "kbn-xsrf": "true",
      Authorization: `Basic ${Buffer.from(`${config.esUser}:${config.esPassword}`).toString("base64")}`,
    },
    body: JSON.stringify({
      input: message,
      agent_id: config.agentId,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return {
      success: false,
      error: `Kibana ${resp.status}: ${text}`,
    };
  }

  const data = (await resp.json()) as Record<string, unknown>;

  const response = data.response as Record<string, unknown> | undefined;
  return {
    success: true,
    conversationId: data.conversation_id as string | undefined,
    agentResponse: (response?.message as string) ?? (data.output as string | undefined),
  };
}
