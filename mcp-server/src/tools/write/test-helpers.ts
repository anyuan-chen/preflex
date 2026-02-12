/**
 * Test helpers for write tool unit tests.
 * Sets up McpServer + Client pair via InMemoryTransport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * Create a connected McpServer + Client pair for testing.
 * Returns callTool helper and cleanup function.
 */
export async function createTestPair(
  registerFn: (server: McpServer) => void,
): Promise<{
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  cleanup: () => Promise<void>;
}> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerFn(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return {
    callTool: async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return result as ToolResult;
    },
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Parse the JSON text from a tool result's first content block. */
export function parseResult(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}
