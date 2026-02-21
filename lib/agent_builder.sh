#!/usr/bin/env bash
# agent_builder.sh — Kibana Agent Builder: connectors, tools, agents

# ── Enable Agent Builder ────────────────────────────────────────────────────

enable_agent_builder() {
  local kb_port="$1"
  log "Enabling Agent Builder setting"
  local resp
  resp=$(kb_curl "$kb_port" PUT "/api/agent_builder/settings" \
    -d '{"is_enabled": true}')
  if echo "$resp" | jq -e '.is_enabled' &>/dev/null; then
    log "Agent Builder enabled"
  else
    warn "Agent Builder enable response: $resp"
  fi
}

# ── Connectors ──────────────────────────────────────────────────────────────

setup_connector() {
  # Creates an OpenAI-compatible connector for a local Ollama model
  local kb_port="$1"
  local ollama_url="${OLLAMA_URL:-http://host.docker.internal:11434}"
  local ollama_model="${OLLAMA_MODEL:-qwen3:4b}"

  log "Creating Ollama connector (${ollama_model} @ ${ollama_url})"
  local resp
  resp=$(kb_curl "$kb_port" POST "/api/actions/connector" \
    -d "{
      \"connector_type_id\": \".gen-ai\",
      \"name\": \"Ollama (${ollama_model})\",
      \"config\": {
        \"apiUrl\": \"${ollama_url}/v1/chat/completions\",
        \"apiProvider\": \"Other\",
        \"defaultModel\": \"${ollama_model}\"
      },
      \"secrets\": {
        \"apiKey\": \"ollama\"
      }
    }")

  local connector_id
  connector_id=$(echo "$resp" | jq -r '.id // empty')
  if [[ -n "$connector_id" ]]; then
    log "Connector created: $connector_id"
    echo "$connector_id"
  else
    warn "Connector creation failed: $resp"
    echo ""
  fi
}

# ── Tools ───────────────────────────────────────────────────────────────────

create_index_search_tool() {
  local kb_port="$1" tool_id="$2" pattern="$3" description="$4"
  log "Creating index_search tool: $tool_id (pattern: $pattern)"
  local resp
  resp=$(kb_curl "$kb_port" POST "/api/agent_builder/tools" \
    -d "{
      \"id\": \"${tool_id}\",
      \"description\": \"${description}\",
      \"type\": \"index_search\",
      \"configuration\": {
        \"pattern\": \"${pattern}\",
        \"row_limit\": 50
      }
    }")

  if echo "$resp" | jq -e '.id' &>/dev/null; then
    log "Tool created: $tool_id"
  else
    warn "Tool creation failed: $resp"
  fi
}

create_esql_tool() {
  local kb_port="$1" tool_id="$2" description="$3" query="$4" params="$5"
  log "Creating ES|QL tool: $tool_id"
  local resp
  resp=$(kb_curl "$kb_port" POST "/api/agent_builder/tools" \
    -d "{
      \"id\": \"${tool_id}\",
      \"description\": \"${description}\",
      \"type\": \"esql\",
      \"configuration\": {
        \"query\": \"${query}\",
        \"params\": ${params}
      }
    }")

  if echo "$resp" | jq -e '.id' &>/dev/null; then
    log "Tool created: $tool_id"
  else
    warn "Tool creation failed: $resp"
  fi
}

# ── Agent ───────────────────────────────────────────────────────────────────

create_agent() {
  local kb_port="$1" agent_id="$2" agent_name="$3" description="$4"
  shift 4
  local tool_ids=("$@")

  # Build tool_ids JSON array
  local tools_json
  tools_json=$(printf '%s\n' "${tool_ids[@]}" | jq -R . | jq -s .)

  log "Creating agent: $agent_id with tools: ${tool_ids[*]}"
  local resp
  resp=$(kb_curl "$kb_port" POST "/api/agent_builder/agents" \
    -d "$(jq -n \
      --arg id "$agent_id" \
      --arg name "$agent_name" \
      --arg desc "$description" \
      --argjson tools "$tools_json" \
      '{
        id: $id,
        name: $name,
        description: $desc,
        configuration: {
          tools: [{ tool_ids: $tools }]
        }
      }')")

  if echo "$resp" | jq -e '.id' &>/dev/null; then
    log "Agent created: $agent_id"
  else
    warn "Agent creation failed: $resp"
  fi
}

# ── MCP Connector ────────────────────────────────────────────────────────────

create_mcp_connector() {
  local kb_port="$1" mcp_url="$2"
  log "Creating MCP connector → $mcp_url"
  local resp
  resp=$(kb_curl "$kb_port" POST "/api/actions/connector" \
    -d "$(jq -n \
      --arg url "$mcp_url" \
      '{
        connector_type_id: ".mcp",
        name: "ES Optimizer MCP",
        config: {
          serverUrl: $url
        },
        secrets: {}
      }')")

  local connector_id
  connector_id=$(echo "$resp" | jq -r '.id // empty')
  if [[ -n "$connector_id" ]]; then
    log "MCP connector created: $connector_id"
    echo "$connector_id"
  else
    warn "MCP connector creation failed: $resp"
    echo ""
  fi
}

import_mcp_tools() {
  local kb_port="$1" mcp_connector_id="$2" namespace="${3:-preflex}"

  # 1. List available tools from MCP server
  log "Listing tools from MCP connector $mcp_connector_id"
  local list_resp
  list_resp=$(kb_curl_internal "$kb_port" GET \
    "/internal/agent_builder/tools/_list_mcp_tools?connectorId=${mcp_connector_id}")

  # Handle both .tools[] and .mcpTools[] response formats
  local tool_names
  tool_names=$(echo "$list_resp" | jq -r '(.mcpTools // .tools // [])[]?.name // empty' 2>/dev/null)
  if [[ -z "$tool_names" ]]; then
    warn "No tools returned from MCP connector: $list_resp"
    return 1
  fi

  local tool_count
  tool_count=$(echo "$tool_names" | wc -l | tr -d ' ')
  log "MCP server exposes $tool_count tools"

  # 2. Build the tools array for bulk import
  local tools_json
  tools_json=$(echo "$list_resp" | jq '[(.mcpTools // .tools // [])[] | {name: .name, description: .description}]')

  # 3. Bulk import via internal API — Kibana often doesn't create all tools
  #    in a single call, so retry until (created + skipped) == total.
  log "Bulk importing $tool_count MCP tools with namespace '$namespace'"
  local payload_file
  payload_file=$(mktemp)
  echo "$tools_json" > "${payload_file}.tools"
  jq -n \
    --arg cid "$mcp_connector_id" \
    --arg ns "$namespace" \
    --slurpfile tools "${payload_file}.tools" \
    '{connector_id: $cid, namespace: $ns, tools: $tools[0]}' > "$payload_file"
  rm -f "${payload_file}.tools"

  local attempts=0 max_attempts=6 total_imported=0
  while (( attempts < max_attempts )); do
    ((attempts++))
    local resp
    resp=$(kb_curl_internal "$kb_port" POST "/internal/agent_builder/tools/_bulk_create_mcp" \
      -d @"$payload_file")

    local created skipped
    created=$(echo "$resp" | jq '.summary.created // 0' 2>/dev/null)
    skipped=$(echo "$resp" | jq '.summary.skipped // 0' 2>/dev/null)

    if [[ "$created" -gt 0 ]]; then
      log "Bulk import pass $attempts: created $created, skipped $skipped"
    fi

    total_imported=$(( created + skipped ))
    if (( total_imported >= tool_count )); then
      log "All $tool_count MCP tools imported (namespace: $namespace)"
      break
    fi

    if (( attempts < max_attempts )); then
      log "Bulk import incomplete ($total_imported/$tool_count) — retrying in 2s..."
      sleep 2
    fi
  done

  if (( total_imported < tool_count )); then
    warn "Only $total_imported/$tool_count tools imported after $max_attempts attempts"
  fi

  rm -f "$payload_file"

  # Return the list of tool names that were exposed (for dynamic tool ID construction)
  echo "$tool_names"
}

# ── Full agent setup for a sandbox ──────────────────────────────────────────

setup_sandbox_agent() {
  local id="$1" kb_port="$2" es_port="$3" mcp_port="$4"
  shift 4
  local scenarios=("$@")

  # 1. Enable Agent Builder
  enable_agent_builder "$kb_port"

  # 2. Create LLM connector
  local connector_id
  connector_id=$(setup_connector "$kb_port")

  # 3. Create MCP connector (points to host MCP server)
  local mcp_connector_id=""
  local mcp_namespace="preflex"
  local mcp_tool_names=""
  if [[ -n "$mcp_port" ]]; then
    local mcp_url
    mcp_url=$(get_mcp_url_for_kibana "$mcp_port")
    mcp_connector_id=$(create_mcp_connector "$kb_port" "$mcp_url")
    if [[ -n "$mcp_connector_id" ]]; then
      mcp_tool_names=$(import_mcp_tools "$kb_port" "$mcp_connector_id" "$mcp_namespace")
    fi
  fi

  # 4. Build index pattern from scenarios
  local index_pattern="sb-${id}-*"

  # 5. Create index search tool
  create_index_search_tool "$kb_port" \
    "optimizer.index_search" \
    "$index_pattern" \
    "Search across all indices in this sandbox. Use this to examine documents, check field types in results, and understand the data."

  # 6. Create cluster diagnostics ES|QL tool
  create_esql_tool "$kb_port" \
    "optimizer.cluster_diag" \
    "Run diagnostic ES|QL queries to check cluster health, shard counts, index stats, and mapping issues. Use this to gather evidence before making recommendations." \
    "FROM .es_index_stats | STATS total_docs = SUM(doc_count), total_shards = COUNT(*) BY index_name | SORT total_docs DESC | LIMIT 50" \
    '{}'

  # 7. Collect all tool IDs (custom + built-in + dynamically imported MCP tools)
  local tool_ids=(
    "optimizer.index_search"
    "optimizer.cluster_diag"
    "platform.core.list_indices"
    "platform.core.get_index_mapping"
    "platform.core.execute_esql"
    "platform.core.generate_esql"
  )

  # Add MCP tools dynamically from what import_mcp_tools reported
  if [[ -n "$mcp_tool_names" ]]; then
    while IFS= read -r name; do
      [[ -n "$name" ]] && tool_ids+=("${mcp_namespace}.${name}")
    done <<< "$mcp_tool_names"
    log "Added ${#tool_ids[@]} total tool IDs (including $(echo "$mcp_tool_names" | wc -l | tr -d ' ') MCP tools)"
  fi

  # 8. Create the optimizer agent
  local system_prompt
  system_prompt="You are an Elasticsearch cluster optimizer. Diagnose performance and configuration problems, then fix them.

For each issue: (1) evidence from the cluster, (2) why it matters, (3) the exact fix.

Use tools to inspect AND modify the cluster:
- Diagnose: cluster_health, index_mapping, field_caps, node_stats, index_stats, shard_info, index_info
- Fix: reindex (copy data with correct mappings), update_settings, shrink_index, manage_aliases

When you find bad mappings, USE reindex to create a fixed copy, then manage_aliases to swap.
Indices in this sandbox are prefixed with 'sb-${id}-'."

  create_agent "$kb_port" \
    "optimizer" \
    "ES Optimizer" \
    "$system_prompt" \
    "${tool_ids[@]}"

  # 9. Update manifest with agent info
  manifest_update "$id" \
    --arg agent_id "optimizer" \
    --arg mcp_connector_id "$mcp_connector_id" \
    --argjson tools "$(printf '%s\n' "${tool_ids[@]}" | jq -R . | jq -s .)" \
    '.agent_id = $agent_id | .mcp_connector_id = $mcp_connector_id | .tools = $tools'
}
