import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { registerReadTools } from "./tools/read/index.js";
import { registerWriteTools } from "./tools/write/index.js";
import { Monitor, type MonitorEvent } from "./stream/monitor.js";
import { getInvocationHistory } from "./stream/invoke.js";
import { config } from "./config.js";
import {
  isSlackConfigured,
  slackAnomalyDetected,
  slackToolCall,
  slackInvocationComplete,
} from "./stream/slack.js";
import type { Response } from "express";

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer(
    { name: "es-optimizer", version: "1.0.0" },
    { capabilities: { logging: {} } },
  );

  registerReadTools(server);
  registerWriteTools(server);

  return server;
}

// ---------------------------------------------------------------------------
// SSE broadcast infrastructure
// ---------------------------------------------------------------------------

const sseClients = new Set<Response>();

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// Read tools (diagnostic) vs write tools (mutating)
const writeTools = new Set([
  "reindex", "update_settings", "manage_aliases", "cancel_task",
]);

// ---------------------------------------------------------------------------
// Express app + MCP transport
// ---------------------------------------------------------------------------

const app = createMcpExpressApp({
  allowedHosts: ["127.0.0.1", "localhost", "[::1]", "host.docker.internal"],
});

// Stateless: each request gets a fresh server+transport (matches SDK examples)
app.post("/mcp", async (req, res) => {
  // Extract tool calls from MCP JSON-RPC before passing to transport
  const body = req.body;
  const messages = Array.isArray(body) ? body : [body];
  for (const msg of messages) {
    if (msg?.method === "tools/call" && msg?.params?.name) {
      const toolName = msg.params.name as string;
      const category = writeTools.has(toolName) ? "write" : "read";
      broadcast("tool_call", {
        tool: toolName,
        category,
        args: msg.params.arguments ?? {},
        timestamp: Date.now(),
      });
      slackToolCall(toolName, category, msg.params.arguments as Record<string, unknown> | undefined);
    }
  }

  const server = createServer();
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", async (_req, res) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST." },
    id: null,
  }));
});

app.delete("/mcp", async (_req, res) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Session management not supported in stateless mode." },
    id: null,
  }));
});

// ---------------------------------------------------------------------------
// SSE endpoint — real-time event stream for dashboard
// ---------------------------------------------------------------------------

app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send initial connected event
  res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);

  sseClients.add(res);

  // Keepalive every 15s
  const keepalive = setInterval(() => {
    res.write(":keepalive\n\n");
  }, 15_000);

  req.on("close", () => {
    sseClients.delete(res);
    clearInterval(keepalive);
  });
});

// CORS preflight for /events
app.options("/events", (_req, res) => {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end();
});

// ---------------------------------------------------------------------------
// Monitor setup
// ---------------------------------------------------------------------------

let monitor: Monitor | null = null;
const recentEvents: MonitorEvent[] = [];
const MAX_RECENT_EVENTS = 50;
let anomalyFiredAt: number | undefined;
let lastAnomalies: import("./stream/anomaly.js").Anomaly[] | undefined;

if (config.monitorEnabled) {
  monitor = new Monitor();
  monitor.on((event) => {
    recentEvents.push(event);
    if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.shift();

    // Broadcast to SSE clients
    if (event.type === "window" && event.window) {
      const w = event.window;
      // Compute aggregate latency and qps across all indices
      const indexEntries = Object.entries(w.indices);
      const totalQps = indexEntries.reduce((s, [, iw]) => s + iw.queryRate, 0);
      const latencies = indexEntries.filter(([, iw]) => iw.queryCount > 0).map(([, iw]) => iw.avgLatency);
      const avgLatency = latencies.length > 0 ? latencies.reduce((s, l) => s + l, 0) / latencies.length : 0;
      broadcast("window", {
        timestamp: w.timestamp,
        cluster: w.cluster,
        nodes: w.nodes,
        indices: w.indices,
        aggregated: { qps: Math.round(totalQps), avgLatency: Math.round(avgLatency * 10) / 10 },
      });
    }

    if (event.type === "anomaly" && event.anomalies) {
      for (const a of event.anomalies) {
        console.log(`[anomaly] ${a.severity} ${a.rule}: ${a.description}`);
        broadcast("anomaly", {
          rule: a.rule,
          severity: a.severity,
          description: a.description,
          index: a.index,
          node: a.node,
          timestamp: Date.now(),
        });
      }
      slackAnomalyDetected(event.anomalies);
      anomalyFiredAt = Date.now();
      lastAnomalies = event.anomalies;
    }

    if (event.type === "invocation" && event.invocationResult) {
      const r = event.invocationResult;
      console.log(`[invocation] success=${r.success}${r.error ? ` error=${r.error}` : ""}`);
      broadcast("invocation", {
        success: r.success,
        error: r.error,
        timestamp: Date.now(),
      });
      slackInvocationComplete(r, lastAnomalies, anomalyFiredAt);
      anomalyFiredAt = undefined;
      lastAnomalies = undefined;
    }
  });
}

// ---------------------------------------------------------------------------
// Status endpoint — monitor observability
// ---------------------------------------------------------------------------

app.get("/status", (_req, res) => {
  const invocations = getInvocationHistory();
  const status = {
    server: "es-optimizer",
    esUrl: config.esUrl,
    verifyMode: config.verifyMode,
    monitor: monitor
      ? {
          enabled: true,
          intervalMs: config.monitorIntervalMs,
          baselineReady: monitor.baseline.ready,
          baselineWindows: monitor.baseline.windowCount,
          activeLocks: Object.fromEntries(monitor.activeLocks),
          windowsBuffered: monitor.processor.windows.length,
          recentEvents: recentEvents.slice(-10).map((e) => ({
            type: e.type,
            timestamp: e.timestamp,
            ...(e.anomalies && {
              anomalyCount: e.anomalies.length,
              anomalies: e.anomalies.map((a) => ({
                rule: a.rule,
                severity: a.severity,
                description: a.description,
                index: a.index,
                node: a.node,
              })),
            }),
            ...(e.invocationResult && { invocationSuccess: e.invocationResult.success }),
          })),
          invocationHistory: {
            total: invocations.length,
            recent: invocations.slice(-5).map((r) => ({
              timestamp: r.timestamp,
              success: r.result.success,
              anomalyCount: r.anomalies.length,
              error: r.result.error,
            })),
          },
        }
      : { enabled: false },
  };

  res.json(status);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(config.mcpPort, () => {
  console.log(`es-optimizer MCP server running at http://127.0.0.1:${config.mcpPort}/mcp`);
  console.log(`  ES target: ${config.esUrl}`);
  console.log(`  Verify mode: ${config.verifyMode}`);

  if (monitor) {
    console.log(`  Monitor: enabled (interval ${config.monitorIntervalMs / 1000}s)`);
    console.log(`  Kibana: ${config.kibanaUrl}`);
    console.log(`  Agent ID: ${config.agentId}`);
    console.log(`  Slack: ${isSlackConfigured() ? `enabled (#${config.slackChannel})` : "disabled (set SLACK_TOKEN + SLACK_CHANNEL)"}`);
    // Seed baseline rapidly, then start normal polling
    monitor.seed().then(() => {
      monitor!.start(config.monitorIntervalMs);
    }).catch((err) => {
      console.error("Baseline seeding failed:", err);
      // Start polling anyway — baseline will warm up normally
      monitor!.start(config.monitorIntervalMs);
    });
  } else {
    console.log("  Monitor: disabled");
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown() {
  console.log("\nShutting down...");
  if (monitor) monitor.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", () => {}); // Ignore SIGHUP so we survive parent shell exit
