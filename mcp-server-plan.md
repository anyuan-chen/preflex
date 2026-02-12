# MCP Server + Verification Pipeline — Implementation Plan

## Overview

Build a TypeScript MCP server that exposes Elasticsearch cluster-ops endpoints (health, shards, mappings, settings, stats, allocation explain) as MCP tools, plus write tools with a three-tier execution model: auto-verify (correctness + performance), HITL (human confirms), and eval mode (skip gates). Integrate into the existing sandbox system and Agent Builder.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Agent Builder (Kibana)                                     │
│    └─ MCP Connector (.mcp) → http://localhost:3100/mcp      │
└─────────────────────┬───────────────────────────────────────┘
                      │ Streamable HTTP (JSON-RPC 2.0)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  es-optimizer-mcp (TypeScript)                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Read Tools   │  │  Write Tools │  │  Verify Pipeline │  │
│  │  (11 tools)   │  │  (5 tools)   │  │  (replay+assert) │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                 │                    │             │
│         └─────────────────┴────────────────────┘             │
│                           │                                  │
│                    es_client (fetch)                          │
│                           │                                  │
└───────────────────────────┼──────────────────────────────────┘
                            ▼
                   Elasticsearch (sandbox)
```

## Technology Choices

- **Language**: TypeScript (stronger typing, Zod schemas, better MCP SDK support)
- **SDK**: `@modelcontextprotocol/sdk` with `McpServer` + `StreamableHTTPServerTransport`
- **Transport**: Streamable HTTP on port 3100 (configurable per sandbox)
- **HTTP framework**: Express (minimal, the SDK examples use it)
- **ES client**: Raw `fetch()` with auth headers (not the heavy @elastic/elasticsearch client — we just need REST calls)
- **Validation**: Zod v4 for tool input schemas

## File Layout

```
mcp-server/
  package.json
  tsconfig.json
  src/
    index.ts                  # Entry point: Express + MCP server setup
    es-client.ts              # Raw fetch wrapper for ES REST API
    tools/
      read/
        index.ts              # Barrel: registers all read tools
        cluster-health.ts     # _cluster/health?level=indices
        index-info.ts         # _cat/indices + _cat/count
        shard-info.ts         # _cat/shards
        node-stats.ts         # _nodes/stats/indices,jvm,thread_pool
        index-mapping.ts      # {index}/_mapping
        field-caps.ts         # {index}/_field_caps?fields=*
        index-settings.ts     # {index}/_settings?include_defaults=true
        index-stats.ts        # {index}/_stats/search,indexing,fielddata,...
        allocation-explain.ts # _cluster/allocation/explain
        query-profile.ts      # {index}/_search with profile:true
        running-tasks.ts      # _tasks?detailed=true&actions=*search*
      write/
        index.ts              # Barrel: registers all write tools
        update-settings.ts    # PUT {index}/_settings
        reindex.ts            # POST _reindex (with verify pipeline)
        shrink-index.ts       # POST {index}/_shrink/{target}
        manage-aliases.ts     # POST _aliases
        cancel-task.ts        # POST _tasks/{id}/_cancel
    verify/
      types.ts                # Shared types: VerifyResult, Baseline, etc.
      baseline.ts             # Capture pre-operation state
      replay.ts               # Re-run query pool after operation
      assert.ts               # Compare before/after (correctness + perf)
      query-pools.ts          # Per-scenario verification queries
    config.ts                 # ES URL, auth, mode (auto/hitl/eval)
```

---

## Step 1: Project Scaffolding + ES Client

**What**: Set up the TypeScript project, install dependencies, create the ES fetch wrapper.

**Files**:
- `mcp-server/package.json` — deps: `@modelcontextprotocol/sdk`, `express`, `zod`, `@types/express`
- `mcp-server/tsconfig.json` — target ES2022, module NodeNext
- `mcp-server/src/config.ts` — reads env vars: `ES_URL`, `ES_USER`, `ES_PASSWORD`, `MCP_PORT`, `VERIFY_MODE`
- `mcp-server/src/es-client.ts` — `esFetch(method, path, body?)` returning parsed JSON

**ES client shape**:
```typescript
// es-client.ts
export async function esFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `${config.esUrl}${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      "Authorization": `Basic ${btoa(`${config.esUser}:${config.esPassword}`)}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ES ${method} ${path} → ${resp.status}: ${text}`);
  }
  return resp.json();
}
```

**Verify**: `npx tsc --noEmit` compiles. Quick smoke test of esFetch against a running sandbox ES port.

---

## Step 2: MCP Server Skeleton + First Read Tool

**What**: Create the Express server with Streamable HTTP transport, register one tool (cluster_health), verify the MCP handshake works.

**Files**:
- `mcp-server/src/index.ts` — Express app + McpServer + StreamableHTTPServerTransport
- `mcp-server/src/tools/read/cluster-health.ts` — first tool

**Server skeleton**:
```typescript
// index.ts
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerReadTools } from "./tools/read/index.js";
import { config } from "./config.js";

const app = express();
app.use(express.json());

const server = new McpServer({
  name: "es-optimizer",
  version: "1.0.0",
});

registerReadTools(server);

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(config.mcpPort, () => {
  console.log(`es-optimizer MCP server on http://localhost:${config.mcpPort}/mcp`);
});
```

**First tool (cluster_health)**:
```typescript
server.tool(
  "cluster_health",
  { level: z.enum(["cluster", "indices", "shards"]).default("indices") },
  async ({ level }) => {
    const result = await esFetch("GET", `/_cluster/health?level=${level}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);
```

**Verify**:
1. `npm run build && npm start` starts without error
2. Send raw JSON-RPC `initialize` + `tools/list` via curl to `http://localhost:3100/mcp`
3. Confirm `cluster_health` appears in tools list
4. Send `tools/call` for cluster_health, confirm ES response comes back

---

## Step 3: All 11 Read Tools

**What**: Implement all diagnostic read tools from the endpoint report.

| Tool | ES Endpoint | Input Params |
|------|-------------|-------------|
| `cluster_health` | `GET /_cluster/health?level={level}` | `level` (default "indices") |
| `index_info` | `GET /_cat/indices/{pattern}?format=json&h=...&s=index` | `pattern` (default "*") |
| `shard_info` | `GET /_cat/shards/{pattern}?format=json&h=...` | `pattern` (default "*") |
| `node_stats` | `GET /_nodes/stats/indices,jvm,thread_pool` | none |
| `index_mapping` | `GET /{index}/_mapping` | `index` (required) |
| `field_caps` | `GET /{index}/_field_caps?fields=*` | `index` (required) |
| `index_settings` | `GET /{index}/_settings?include_defaults=true&flat_settings=true` | `index` (required) |
| `index_stats` | `GET /{index}/_stats/search,indexing,fielddata,query_cache,segments,store` | `index` (required) |
| `allocation_explain` | `POST /_cluster/allocation/explain` | `index` (optional), `shard` (optional), `primary` (optional) |
| `query_profile` | `POST /{index}/_search` with `profile:true` | `index`, `query` (JSON object), `size` (default 0) |
| `running_tasks` | `GET /_tasks?detailed=true&actions=*search*` | none |

**Pattern**: Each tool is a separate file exporting a register function. `index.ts` barrel calls them all.

**Verify**: For each tool:
1. `tools/list` returns all 11 with correct input schemas
2. `tools/call` each tool against a running sandbox, verify ES data in response
3. Test with bad input (missing required fields) → proper error response

---

## Step 4: Verification Pipeline Core Types + Baseline Capture

**What**: Build the verification infrastructure. Before any write operation, capture a baseline snapshot.

**Files**:
- `mcp-server/src/verify/types.ts`
- `mcp-server/src/verify/baseline.ts`

**Types**:
```typescript
// verify/types.ts
export interface Baseline {
  captured_at: string;
  operation: "reindex" | "shrink" | "update_settings" | "manage_aliases";
  target_index: string;
  doc_count: number;
  mapping: Record<string, unknown>;
  settings: Record<string, unknown>;
  aliases: Record<string, unknown>;
  health: string;
  shard_count: number;
  query_benchmarks: QueryBenchmark[];
}

export interface QueryBenchmark {
  label: string;
  query_body: Record<string, unknown>;
  index: string;
  took_ms: number;
  total_hits: number;
  status: number;
  sample_hit_ids: string[];
}

export interface VerifyResult {
  passed: boolean;
  correctness: {
    doc_count_match: boolean;
    mapping_correct: boolean;
    sample_queries_pass: boolean;
    details: string[];
  };
  performance: {
    improved: boolean;
    before_avg_ms: number;
    after_avg_ms: number;
    per_query: Array<{
      label: string;
      before_ms: number;
      after_ms: number;
      hits_match: boolean;
    }>;
  };
  recommendation: "auto_approve" | "hitl_review" | "rollback";
  summary: string;
}
```

**Baseline capture**: Given an index and a list of queries, run each query 3 times, record median took_ms and hit counts. Also capture doc_count, mapping, settings, aliases via ES APIs.

**Verify**: Unit test with mock ES responses. Baseline captures all expected fields.

---

## Step 5: Query Replay + Assertion Engine

**What**: After a write operation, replay the same queries and compare before/after.

**Files**:
- `mcp-server/src/verify/replay.ts`
- `mcp-server/src/verify/assert.ts`

**Replay**: Run each baseline query against the target index 3 times, take median.

**Assertion logic**:
- **doc_count_match**: target count == source count
- **sample_queries_pass**: each query returns >= same hit count
- **performance improved**: average took_ms after <= 1.1x average before (10% tolerance)

**Decision matrix**:
| Correct | Performance | → Recommendation |
|---------|------------|------------------|
| YES | Improved or same | `auto_approve` |
| YES | Degraded | `hitl_review` |
| NO | Any | `rollback` |

**Verify**: Unit test with synthetic data:
- Same count + faster → auto_approve
- Same count + slower → hitl_review
- Different count → rollback

---

## Step 6: Per-Scenario Query Pools for Replay

**What**: Define verification queries for each scenario. These come from the eval bombardment queries.

**File**: `mcp-server/src/verify/query-pools.ts`

| Scenario | Queries | What "correct" means after fix |
|----------|---------|-------------------------------|
| bad-mapping | date range, date histogram, terms agg on service, numeric range, sort by duration | Queries that errored before now return results |
| over-sharded | match_all, terms agg, percentiles | Same results, lower latency (fewer shards) |
| slow-queries | basic filter | Results still returned |
| bad-replicas | match_all on both indices | Results returned, cluster healthy |

Index names use `{prefix}` placeholder, substituted at runtime with the sandbox's `sb-{id}-` prefix.

**Verify**: Each pool loads. Pattern substitution works with real sandbox prefix.

---

## Step 7: Write Tool — `update_settings`

**What**: First write tool. Dynamic settings update. **Verifiable**: can read back setting + replay queries.

**Input**: `index` (string), `settings` (object, e.g. `{"index.number_of_replicas": 0}`)

**Flow**:
1. Capture baseline (current settings, health, query benchmarks)
2. Apply: `PUT /{index}/_settings`
3. Read back: `GET /{index}/_settings` — confirm change
4. Replay queries, assert correctness + performance
5. Return verification result with recommendation

**Rollback**: PUT the original setting value back.

**Three modes**:
- `eval`: Apply immediately, return result
- `auto`: Apply → verify → auto-approve or rollback
- `hitl`: Return preview, wait for confirm

**Verify**: Against bad-replicas sandbox, set replicas=0 on overreplicated index → cluster goes green → auto_approve.

---

## Step 8: Write Tool — `reindex`

**What**: Most complex write. Create new index with correct mappings, copy data, verify. **Verifiable**.

**Input**: `source_index`, `target_index`, `target_mappings` (object), `target_settings` (optional object)

**Flow**:
1. Capture baseline on source (doc count, mappings, query benchmarks)
2. Create target index with provided mappings
3. `POST /_reindex` — copy data
4. Verify: failures empty, created count matches, `_count` matches
5. Verify: target mapping has intended types
6. Replay queries against target, assert correctness + performance
7. Return verification result

**Rollback**: Delete target index (source untouched).

**Verify**: Bad-mapping scenario. Reindex with correct types → date range query works → auto_approve.

---

## Step 9: Write Tool — `shrink_index`

**What**: Reduce shard count. **Verifiable**: doc counts match, fewer shards = less overhead.

**Input**: `source_index`, `target_index`, `target_shards` (number)

**Flow**:
1. Capture baseline
2. Pre-flight: verify target_shards is factor of current count
3. Block writes + force allocation to one node
4. Wait for relocation
5. `POST /{source}/_shrink/{target}`
6. Wait for green health
7. Verify doc count, replay queries
8. Return verification result

**Rollback**: Delete target, remove write block + allocation requirement from source.

**Verify**: Over-sharded (10 shards → 1). Doc count matches. Performance same or better.

---

## Step 10: Write Tool — `manage_aliases`

**What**: Atomic alias swap. **Verifiable**: alias points to right index, queries through alias work.

**Input**: `actions` array of `{action: "add"|"remove", index, alias}`

**Flow**:
1. Capture current alias state
2. `POST /_aliases` with actions
3. Verify alias points to intended index
4. Replay query through alias
5. Return result

**Rollback**: Execute inverse actions.

---

## Step 11: Write Tool — `cancel_task`

**What**: Kill a runaway query. **Always safe**, no verification needed.

**Input**: `task_id` (string)

**Flow**: `POST /_tasks/{task_id}/_cancel`, return result.

---

## Step 12: Sandbox Integration — MCP Server Lifecycle

**What**: Integrate MCP server into sandbox create/destroy. Each sandbox gets its own MCP server.

**Changes**:
- `sandbox.conf` — add `MCP_PORT_BASE=3100`
- `lib/common.sh` — `find_available_ports()` also finds MCP port
- `lib/manifest.sh` — manifest includes `mcp_port`, `mcp_pid`
- New file: `lib/mcp.sh` — `start_mcp_server()`, `stop_mcp_server()`, `wait_for_mcp()`
- `sandbox` CLI — `cmd_create` starts MCP after ES is ready, `cmd_destroy` kills it

**Note**: MCP server runs on the host (not in Docker), connecting to the sandbox's ES container at `localhost:{es_port}`.

**Verify**: `./sandbox create` starts MCP. `./sandbox list` shows MCP port. `./sandbox destroy` kills it.

---

## Step 13: Agent Builder MCP Connector Integration

**What**: Create `.mcp` connector in Kibana pointing to the MCP server, import tools.

**Changes to `lib/agent_builder.sh`**:
- `create_mcp_connector()` — `POST /api/actions/connector` with `connector_type_id: .mcp`, URL: `http://host.docker.internal:{mcp_port}/mcp`
- Bulk import tools with namespace "optimizer"
- Agent references both built-in tools and MCP tools

**Note**: `host.docker.internal` for macOS Docker Desktop. Detect OS for Linux compatibility.

**Verify**: MCP connector created. `listTools` returns all 16 tools. Agent can call them.

---

## Step 14: End-to-End Test Script

**What**: Single script exercising the full pipeline.

**File**: `test/e2e-mcp.sh`

**Flow**:
1. `./sandbox create --scenarios=bad-mapping --id=mcptest`
2. Test all read tools via JSON-RPC
3. Test reindex write tool with correct mappings
4. Verify verification report says "auto_approve"
5. `./sandbox destroy mcptest`

---

## Step 15: HITL Mode — Preview + Confirm

**What**: When `VERIFY_MODE=hitl`, write tools return a preview instead of executing.

**Additional tools**:
- `confirm_operation` — executes a previewed operation by `operation_id`
- `cancel_operation` — discards a previewed operation

Uses an in-memory operation store (Map keyed by operation_id). Preview includes: what will change, expected impact, risk assessment.

**Verify**: Set mode=hitl, call update_settings → get preview. Call confirm → executes. Call cancel → discards.

---

## Implementation Order

| Step | What | Deps | Key Verification |
|------|------|------|------------------|
| 1 | Scaffolding + ES client | None | tsc compiles, fetch works |
| 2 | MCP skeleton + first tool | 1 | JSON-RPC handshake works |
| 3 | All 11 read tools | 2 | Each returns ES data |
| 4 | Verify types + baseline | 1 | Unit test captures fields |
| 5 | Replay + assert engine | 4 | Unit test decision matrix |
| 6 | Scenario query pools | 5 | Pools load correctly |
| 7 | Write: update_settings | 3,5,6 | Replica fix → green |
| 8 | Write: reindex | 3,5,6 | Mapping fix → queries work |
| 9 | Write: shrink_index | 3,5,6 | 10→1 shards, docs match |
| 10 | Write: manage_aliases | 3,5 | Alias swap works |
| 11 | Write: cancel_task | 2 | Task cancelled |
| 12 | Sandbox integration | 1-11 | create/destroy manages MCP |
| 13 | Agent Builder connector | 12 | Tools visible in Kibana |
| 14 | E2E test | 1-13 | Full pipeline end-to-end |
| 15 | HITL mode | 7-11 | Preview → confirm flow |

## Risk Areas

1. **`host.docker.internal`** — works on macOS Docker Desktop. Linux needs `--add-host` or Docker bridge IP. Detect in `lib/mcp.sh`.
2. **Streamable HTTP statelessness** — start stateless (no session). Switch to stateful if Agent Builder requires it.
3. **Reindex duration** — sandbox data is tiny (~1000 docs), so synchronous is fine. Add async + task polling later for real use.
4. **Shrink shard relocation** — single-node sandbox means all shards already on one node. Allocation step is a no-op but included for correctness.
5. **MCP `.mcp` connector type** — relatively new (ES 9.x). Fallback: create tools via Agent Builder API directly.
