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
  # Creates an OpenAI-compatible connector for Gemini
  # Requires GEMINI_API_KEY env var
  local kb_port="$1"
  local api_key="${GEMINI_API_KEY:-}"

  if [[ -z "$api_key" ]]; then
    warn "GEMINI_API_KEY not set — skipping connector creation"
    echo ""
    return 0
  fi

  log "Creating Gemini connector via OpenAI-compatible endpoint"
  local resp
  resp=$(kb_curl "$kb_port" POST "/api/actions/connector" \
    -d "{
      \"connector_type_id\": \".gen-ai\",
      \"name\": \"Gemini (sandbox)\",
      \"config\": {
        \"apiUrl\": \"https://generativelanguage.googleapis.com/v1beta/openai/chat/completions\",
        \"apiProvider\": \"Other\",
        \"defaultModel\": \"gemini-2.0-flash\"
      },
      \"secrets\": {
        \"apiKey\": \"${api_key}\"
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
          url: $url,
          headers: ""
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
  local kb_port="$1" mcp_connector_id="$2"

  # List available tools from the MCP server
  log "Importing tools from MCP connector $mcp_connector_id"
  local resp
  resp=$(kb_curl "$kb_port" POST "/api/actions/connector/${mcp_connector_id}/_execute" \
    -d '{
      "params": {
        "subAction": "listTools"
      }
    }')

  local tool_count
  tool_count=$(echo "$resp" | jq '.data.tools | length // 0')
  if [[ "$tool_count" -gt 0 ]]; then
    log "MCP server exposes $tool_count tools"
  else
    warn "No tools returned from MCP connector: $resp"
  fi
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
  if [[ -n "$mcp_port" ]]; then
    local mcp_url
    mcp_url=$(get_mcp_url_for_kibana "$mcp_port")
    mcp_connector_id=$(create_mcp_connector "$kb_port" "$mcp_url")
    if [[ -n "$mcp_connector_id" ]]; then
      import_mcp_tools "$kb_port" "$mcp_connector_id"
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

  # 7. Collect all tool IDs (custom + built-in + MCP)
  local tool_ids=(
    "optimizer.index_search"
    "optimizer.cluster_diag"
    "platform.core.list_indices"
    "platform.core.get_index_mapping"
    "platform.core.execute_esql"
    "platform.core.generate_esql"
  )

  # Add MCP tools if connector was created
  if [[ -n "$mcp_connector_id" ]]; then
    tool_ids+=("mcp.${mcp_connector_id}.cluster_health")
    tool_ids+=("mcp.${mcp_connector_id}.index_info")
    tool_ids+=("mcp.${mcp_connector_id}.shard_info")
    tool_ids+=("mcp.${mcp_connector_id}.node_stats")
    tool_ids+=("mcp.${mcp_connector_id}.index_mapping")
    tool_ids+=("mcp.${mcp_connector_id}.field_caps")
    tool_ids+=("mcp.${mcp_connector_id}.index_settings")
    tool_ids+=("mcp.${mcp_connector_id}.index_stats")
    tool_ids+=("mcp.${mcp_connector_id}.allocation_explain")
    tool_ids+=("mcp.${mcp_connector_id}.query_profile")
    tool_ids+=("mcp.${mcp_connector_id}.running_tasks")
    tool_ids+=("mcp.${mcp_connector_id}.update_settings")
    tool_ids+=("mcp.${mcp_connector_id}.reindex")
    tool_ids+=("mcp.${mcp_connector_id}.shrink_index")
    tool_ids+=("mcp.${mcp_connector_id}.manage_aliases")
    tool_ids+=("mcp.${mcp_connector_id}.cancel_task")
    tool_ids+=("mcp.${mcp_connector_id}.confirm_operation")
    tool_ids+=("mcp.${mcp_connector_id}.cancel_operation")
    tool_ids+=("mcp.${mcp_connector_id}.list_pending_operations")
  fi

  # 8. Create the optimizer agent
  local system_prompt
  system_prompt="You are an Elasticsearch cluster optimizer. Your job is to diagnose performance and configuration problems in this Elasticsearch cluster and recommend specific fixes.

For each issue you find, provide:
1. What the problem is (with evidence from the cluster)
2. Why it matters (performance impact, risk)
3. The exact API call or configuration change to fix it

You have access to MCP tools that let you directly inspect and modify the cluster. Use them to:
- Diagnose: cluster_health, index_info, shard_info, index_mapping, index_settings, index_stats, field_caps, node_stats, allocation_explain, query_profile
- Fix: update_settings, reindex, shrink_index, manage_aliases

Focus areas: mapping types, shard counts, replica configuration, query performance, index settings.

Indices in this sandbox are prefixed with 'sb-${id}-'. Examine all of them.
Always start by checking cluster_health and index_info to understand the cluster state."

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
