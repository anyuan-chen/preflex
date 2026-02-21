// mcp-proxy.ts — JSON-RPC client for the Preflex MCP server

export interface McpResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
}

let requestId = 1;

/**
 * Send a JSON-RPC request to the MCP server.
 */
async function rpc<T>(
  baseUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const id = requestId++;
  const body = {
    jsonrpc: "2.0",
    id,
    method,
    params,
  };

  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`MCP server returned ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as McpResponse<T>;

  if (json.error) {
    throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
  }

  return json.result as T;
}

/**
 * Initialize the MCP session (stateless — each call is independent, but we
 * follow protocol for correctness).
 */
export async function mcpInitialize(baseUrl: string): Promise<void> {
  await rpc(baseUrl, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "preflex-bot", version: "1.0" },
  });
}

/**
 * List available MCP tools.
 */
export async function mcpListTools(
  baseUrl: string,
): Promise<Array<{ name: string; description: string }>> {
  const result = await rpc<{ tools: Array<{ name: string; description: string }> }>(
    baseUrl,
    "tools/list",
    {},
  );
  return result.tools;
}

/**
 * Call an MCP tool and return the text content.
 */
export async function mcpCallTool(
  baseUrl: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await rpc<McpToolResult>(baseUrl, "tools/call", {
    name: toolName,
    arguments: args,
  });

  const textContent = result.content.find((c) => c.type === "text");
  return textContent?.text ?? "";
}

/**
 * Convenience wrappers for commonly used ES tools.
 */
export class McpClient {
  constructor(private baseUrl: string) {}

  async initialize(): Promise<void> {
    return mcpInitialize(this.baseUrl);
  }

  async listTools(): Promise<Array<{ name: string; description: string }>> {
    return mcpListTools(this.baseUrl);
  }

  async clusterHealth(): Promise<string> {
    return mcpCallTool(this.baseUrl, "cluster_health", { level: "indices" });
  }

  async indexMapping(index: string): Promise<string> {
    return mcpCallTool(this.baseUrl, "index_mapping", { index });
  }

  async fieldCaps(index: string): Promise<string> {
    return mcpCallTool(this.baseUrl, "field_caps", { index });
  }

  async indexStats(index: string): Promise<string> {
    return mcpCallTool(this.baseUrl, "index_stats", { index });
  }

  async queryProfile(
    index: string,
    query: Record<string, unknown>,
    size?: number,
  ): Promise<string> {
    return mcpCallTool(this.baseUrl, "query_profile", {
      index,
      query,
      size: size ?? 0,
    });
  }
}
