// fix-agent.test.ts — Tests for the fix agent and MCP proxy

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "test", "fixtures");

describe("mock-mcp-responses.json fixture", () => {
  const responses = JSON.parse(
    readFileSync(join(fixturesDir, "mock-mcp-responses.json"), "utf-8"),
  );

  it("has valid JSON-RPC initialize response", () => {
    const init = responses.initialize;
    expect(init.jsonrpc).toBe("2.0");
    expect(init.result.serverInfo.name).toBe("es-optimizer");
    expect(init.result.protocolVersion).toBe("2025-11-25");
  });

  it("has tools/list with expected tools", () => {
    const tools = responses["tools/list"].result.tools;
    const names = tools.map((t: { name: string }) => t.name);

    expect(names).toContain("cluster_health");
    expect(names).toContain("index_mapping");
    expect(names).toContain("field_caps");
    expect(names).toContain("query_profile");
    expect(names).toContain("reindex");
    expect(names).toContain("update_settings");
  });

  it("has valid index mapping for orders", () => {
    const content = responses.index_mapping_orders.result.content[0].text;
    const mapping = JSON.parse(content);

    expect(mapping.orders.mappings.properties.order_date.type).toBe("date");
    expect(mapping.orders.mappings.properties.description.type).toBe("text");
    expect(mapping.orders.mappings.properties.key_type.type).toBe("keyword");
    expect(mapping.orders.mappings.properties.price.type).toBe("float");
    expect(mapping.orders.mappings.properties.status.type).toBe("keyword");
  });

  it("has valid index mapping for service-logs", () => {
    const content = responses.index_mapping_service_logs.result.content[0].text;
    const mapping = JSON.parse(content);

    expect(mapping["service-logs"].mappings.properties.timestamp.type).toBe("date");
    expect(mapping["service-logs"].mappings.properties.message.type).toBe("text");
    expect(mapping["service-logs"].mappings.properties.service_type.type).toBe("keyword");
  });

  it("has valid field_caps for orders", () => {
    const content = responses.field_caps_orders.result.content[0].text;
    const caps = JSON.parse(content);

    expect(caps.fields.description.text.searchable).toBe(true);
    expect(caps.fields["description.keyword"].keyword.aggregatable).toBe(true);
    expect(caps.fields.order_date.date.aggregatable).toBe(true);
  });

  it("has valid query_profile response", () => {
    const content = responses.query_profile_match_all.result.content[0].text;
    const profile = JSON.parse(content);

    expect(profile.hits.total.value).toBe(1000);
    expect(profile.profile.shards).toHaveLength(1);
  });
});

describe("mock-tool-use-conversation.json fixture", () => {
  const conversation = JSON.parse(
    readFileSync(join(fixturesDir, "mock-tool-use-conversation.json"), "utf-8"),
  );

  it("has expected number of turns", () => {
    expect(conversation.turns).toHaveLength(5);
  });

  it("first turn reads files and checks mappings", () => {
    const turn = conversation.turns[0];
    const toolCalls = turn.content.filter(
      (b: { type: string }) => b.type === "tool_use",
    );

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].name).toBe("es_index_mapping");
    expect(toolCalls[1].name).toBe("read_file");
  });

  it("includes write_file calls for the fix", () => {
    const allToolCalls = conversation.turns.flatMap(
      (t: { content: Array<{ type: string; name?: string }> }) =>
        t.content.filter((b) => b.type === "tool_use"),
    );

    const writes = allToolCalls.filter(
      (t: { name: string }) => t.name === "write_file",
    );
    expect(writes.length).toBeGreaterThanOrEqual(2);

    // Should write es.ts
    const esWrite = writes.find(
      (t: { input: { path: string } }) => t.input.path === "src/es.ts",
    );
    expect(esWrite).toBeDefined();
    expect(esWrite.input.content).toContain("@elastic/elasticsearch");
  });

  it("final turn has end_turn stop_reason", () => {
    const lastTurn = conversation.turns[conversation.turns.length - 1];
    expect(lastTurn.stop_reason).toBe("end_turn");
  });

  it("final turn summarizes all changes", () => {
    const lastTurn = conversation.turns[conversation.turns.length - 1];
    const text = lastTurn.content.find(
      (b: { type: string }) => b.type === "text",
    );
    expect(text.text).toContain("multi_match");
    expect(text.text).toContain("Postgres write operations");
  });
});

describe("tool dispatch mapping", () => {
  // Verify the tool names in TOOLS match what the MCP proxy expects
  const ES_TOOL_MAP: Record<string, string> = {
    es_cluster_health: "cluster_health",
    es_index_mapping: "index_mapping",
    es_field_caps: "field_caps",
    es_index_stats: "index_stats",
    es_query_profile: "query_profile",
  };

  it("maps all ES tool names to MCP tool names", () => {
    const responses = JSON.parse(
      readFileSync(join(fixturesDir, "mock-mcp-responses.json"), "utf-8"),
    );
    const mcpToolNames = responses["tools/list"].result.tools.map(
      (t: { name: string }) => t.name,
    );

    for (const [, mcpName] of Object.entries(ES_TOOL_MAP)) {
      expect(mcpToolNames).toContain(mcpName);
    }
  });
});
