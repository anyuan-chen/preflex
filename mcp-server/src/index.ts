import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { registerReadTools } from "./tools/read/index.js";
import { registerWriteTools } from "./tools/write/index.js";
import { config } from "./config.js";

function createServer(): McpServer {
  const server = new McpServer(
    { name: "es-optimizer", version: "1.0.0" },
    { capabilities: { logging: {} } },
  );

  registerReadTools(server);
  registerWriteTools(server);

  return server;
}

const app = createMcpExpressApp();

// Stateless: each request gets a fresh server+transport (matches SDK examples)
app.post("/mcp", async (req, res) => {
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

// GET for server-initiated SSE streams (required by spec for DELETE)
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

app.listen(config.mcpPort, () => {
  console.log(`es-optimizer MCP server running at http://127.0.0.1:${config.mcpPort}/mcp`);
  console.log(`  ES target: ${config.esUrl}`);
  console.log(`  Verify mode: ${config.verifyMode}`);
});
