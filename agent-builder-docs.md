# Elastic Agent Builder — Hard-Won Notes

## Gotchas

### Encryption keys must be in kibana.yml
Setting `xpack.encryptedSavedObjects.encryptionKey` via Docker `-e` env vars is unreliable. The Connectors API silently returns 500s. Fix: write directly to `/usr/share/kibana/config/kibana.yml` and restart.

### Gemini API keys don't work with `.gemini` connector
The `.gemini` connector type expects GCP Vertex AI service account JSON (`client_email`, `private_key`, etc). Google AI Studio API keys must use the `.gen-ai` (OpenAI) connector with Gemini's OpenAI-compatible endpoint:
```
apiUrl: https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
apiProvider: Other
```

### Agent Builder requires 9.2+
Not available in 8.x. Must be explicitly enabled at Stack Management > AI > Agent Builder.

### ES security must be enabled
`xpack.security.enabled=true` is required for connectors to work. Without it, the entire `/api/actions/*` API 500s.

---

## Undocumented / Useful API Endpoints

```
GET  /api/agent_builder/agents          — list all agents
GET  /api/agent_builder/tools           — list all available tools
POST /api/actions/connector             — create a connector
POST /api/actions/connector/<id>/_execute — test a connector
GET  /api/actions/connector_types       — list connector types
```
All require `kbn-xsrf: true` header and Basic auth.

## Built-in Tool IDs

| Tool ID | What it does |
|---|---|
| `platform.core.search` | Full-text + aggregation search (auto-selects index) |
| `platform.core.list_indices` | List indices/aliases/datastreams |
| `platform.core.get_index_mapping` | Get index mappings |
| `platform.core.get_document_by_id` | Fetch doc by ID |
| `platform.core.execute_esql` | Run ES\|QL (must pair with generate_esql) |
| `platform.core.generate_esql` | Natural language → ES\|QL |
| `platform.core.index_explorer` | Find relevant indices from description |

Default agent only has: search, list_indices, get_index_mapping, get_document_by_id.
ES|QL and index_explorer are available but must be added to custom agents.

---

## CRUD API Shapes (discovered by probing)

### Create Tool (ES|QL)
```
POST /api/agent_builder/tools
{
  "id": "namespace.tool_name",      # required, unique
  "description": "...",              # required
  "type": "esql",                    # esql | index_search | mcp
  "configuration": {
    "query": "FROM idx | WHERE x == ?param | LIMIT 10",
    "params": {                      # required even if empty
      "param": { "type": "string", "description": "..." }
    }
  }
}
```
- NO `name` field (rejected)
- `params` object required even if empty `{}`
- Param types: string, text, keyword, integer, float, long, double, boolean, date, object, nested, array
- Use `?param_name` syntax in query for interpolation

### Create Tool (Index Search)
```
POST /api/agent_builder/tools
{
  "id": "namespace.tool_name",
  "description": "...",
  "type": "index_search",
  "configuration": {
    "pattern": "logs-*",             # must match existing indices
    "row_limit": 50,                 # optional
    "custom_instructions": "..."     # optional, domain guidance
  }
}
```
- Pattern must match existing indices at creation time

### Create Agent
```
POST /api/agent_builder/agents
{
  "id": "namespace.agent_name",     # required
  "name": "Display Name",           # required (unlike tools!)
  "description": "...",             # doubles as system instructions
  "configuration": {
    "tools": [
      { "tool_ids": ["platform.core.search", "custom.tool_id"] }
    ]
  }
}
```
- `name` IS required (opposite of tools)
- No separate `instructions` field — use `description` for system prompt
- Returns with `"type": "chat"` and `"readonly": false`

### Update Agent
```
PUT /api/agent_builder/agents/<agent_id>
# Same body as POST but WITHOUT id field
```

### Delete
```
DELETE /api/agent_builder/agents/<id>    → {"success": true}
DELETE /api/agent_builder/tools/<id>     → {"success": true}
```

---

## ES Stats Endpoints (useful for optimizer tools)

Node-level index stats (`GET /_nodes/stats/indices`):
`docs, shard_stats, store, indexing, get, search, merges, refresh, flush, warmer, query_cache, fielddata, completion, segments, translog, request_cache, recovery, bulk, mappings, dense_vector, sparse_vector`

Cluster stats (`GET /_cluster/stats`):
`count, shards, docs, store, fielddata, query_cache, completion, segments, mappings, analysis, versions, search, dense_vector, sparse_vector`
