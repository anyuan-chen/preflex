#!/usr/bin/env bash
# e2e-mcp.sh — End-to-end test of MCP server against a sandbox
#
# Usage: ./test/e2e-mcp.sh [sandbox-id]
#   If sandbox-id is provided, uses that existing sandbox.
#   Otherwise, creates a fresh sandbox with bad-mapping scenario.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
SKIP=0

# ── Helpers ──────────────────────────────────────────────────────────────────

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }

assert_ok() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    green "  ✓ $label"
    ((PASS++))
  else
    red "  ✗ $label"
    ((FAIL++))
  fi
}

assert_json_field() {
  local label="$1" json="$2" field="$3"
  if echo "$json" | jq -e "$field" >/dev/null 2>&1; then
    green "  ✓ $label"
    ((PASS++))
  else
    red "  ✗ $label (field: $field)"
    ((FAIL++))
  fi
}

# JSON-RPC helper: send a method call to the MCP server
mcp_call() {
  local port="$1" method="$2" params="$3"
  local id=$((RANDOM % 10000))
  curl -sf "http://127.0.0.1:${port}/mcp" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
      --arg method "$method" \
      --argjson params "$params" \
      --argjson id "$id" \
      '{jsonrpc: "2.0", id: $id, method: $method, params: $params}')"
}

mcp_initialize() {
  local port="$1"
  mcp_call "$port" "initialize" '{
    "protocolVersion": "2025-11-25",
    "capabilities": {},
    "clientInfo": {"name": "e2e-test", "version": "0.1"}
  }'
}

mcp_list_tools() {
  local port="$1"
  mcp_call "$port" "tools/list" '{}'
}

mcp_call_tool() {
  local port="$1" tool_name="$2" args="$3"
  mcp_call "$port" "tools/call" "$(jq -n \
    --arg name "$tool_name" \
    --argjson args "$args" \
    '{name: $name, arguments: $args}')"
}

# ── Setup ────────────────────────────────────────────────────────────────────

CREATED_SANDBOX=""

if [[ -n "${1:-}" ]]; then
  SANDBOX_ID="$1"
  echo "Using existing sandbox: $SANDBOX_ID"
  MANIFEST="${SCRIPT_DIR}/sandboxes/${SANDBOX_ID}/manifest.json"
  if [[ ! -f "$MANIFEST" ]]; then
    red "Manifest not found: $MANIFEST"
    exit 1
  fi
else
  echo "Creating test sandbox with bad-mapping scenario..."
  SANDBOX_ID=$("${SCRIPT_DIR}/sandbox" create --scenarios=bad-mapping 2>&1 | grep -oP 'ID: \K\w+' || true)
  if [[ -z "$SANDBOX_ID" ]]; then
    # Try alternate parsing
    SANDBOX_ID=$("${SCRIPT_DIR}/sandbox" create --scenarios=bad-mapping 2>&1 | tail -1 | awk '{print $NF}')
  fi
  if [[ -z "$SANDBOX_ID" ]]; then
    red "Failed to create sandbox"
    exit 1
  fi
  CREATED_SANDBOX="$SANDBOX_ID"
  MANIFEST="${SCRIPT_DIR}/sandboxes/${SANDBOX_ID}/manifest.json"
  echo "Created sandbox: $SANDBOX_ID"
fi

MCP_PORT=$(jq -r '.mcp_port' "$MANIFEST")
ES_PORT=$(jq -r '.es_port' "$MANIFEST")

if [[ -z "$MCP_PORT" || "$MCP_PORT" == "null" ]]; then
  red "No MCP port in manifest"
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  E2E MCP Test — sandbox=$SANDBOX_ID mcp=$MCP_PORT es=$ES_PORT"
echo "═══════════════════════════════════════════════════════"

# ── Test 1: MCP Handshake ────────────────────────────────────────────────────

echo ""
echo "── Test 1: MCP Protocol Handshake ──"

INIT_RESP=$(mcp_initialize "$MCP_PORT" 2>&1 || echo '{}')
assert_json_field "initialize returns serverInfo" "$INIT_RESP" '.result.serverInfo.name'
assert_json_field "protocol version present" "$INIT_RESP" '.result.protocolVersion'

# ── Test 2: List Tools ───────────────────────────────────────────────────────

echo ""
echo "── Test 2: Tool Discovery ──"

TOOLS_RESP=$(mcp_list_tools "$MCP_PORT" 2>&1 || echo '{}')
TOOL_COUNT=$(echo "$TOOLS_RESP" | jq '.result.tools | length // 0')

if [[ "$TOOL_COUNT" -ge 19 ]]; then
  green "  ✓ Found $TOOL_COUNT tools (expected ≥19)"
  ((PASS++))
else
  red "  ✗ Found $TOOL_COUNT tools (expected ≥19)"
  ((FAIL++))
fi

# Check specific tools exist
for tool in cluster_health index_info shard_info node_stats index_mapping \
            field_caps index_settings index_stats allocation_explain \
            query_profile running_tasks update_settings reindex \
            shrink_index manage_aliases cancel_task \
            confirm_operation cancel_operation list_pending_operations; do
  if echo "$TOOLS_RESP" | jq -e ".result.tools[] | select(.name == \"$tool\")" >/dev/null 2>&1; then
    green "  ✓ Tool exists: $tool"
    ((PASS++))
  else
    red "  ✗ Tool missing: $tool"
    ((FAIL++))
  fi
done

# ── Test 3: Read Tools ───────────────────────────────────────────────────────

echo ""
echo "── Test 3: Read Tools ──"

# cluster_health
RESP=$(mcp_call_tool "$MCP_PORT" "cluster_health" '{"level": "indices"}' 2>&1 || echo '{}')
CONTENT=$(echo "$RESP" | jq -r '.result.content[0].text // empty')
assert_json_field "cluster_health returns status" "$CONTENT" '.status'

# index_info
RESP=$(mcp_call_tool "$MCP_PORT" "index_info" '{"pattern": "sb-*"}' 2>&1 || echo '{}')
CONTENT=$(echo "$RESP" | jq -r '.result.content[0].text // empty')
if echo "$CONTENT" | jq -e 'length > 0' >/dev/null 2>&1; then
  green "  ✓ index_info returns indices"
  ((PASS++))
else
  red "  ✗ index_info returned no indices"
  ((FAIL++))
fi

# shard_info
RESP=$(mcp_call_tool "$MCP_PORT" "shard_info" '{"pattern": "sb-*"}' 2>&1 || echo '{}')
CONTENT=$(echo "$RESP" | jq -r '.result.content[0].text // empty')
if echo "$CONTENT" | jq -e 'length > 0' >/dev/null 2>&1; then
  green "  ✓ shard_info returns shards"
  ((PASS++))
else
  red "  ✗ shard_info returned no shards"
  ((FAIL++))
fi

# node_stats
RESP=$(mcp_call_tool "$MCP_PORT" "node_stats" '{}' 2>&1 || echo '{}')
CONTENT=$(echo "$RESP" | jq -r '.result.content[0].text // empty')
assert_json_field "node_stats returns nodes" "$CONTENT" '.nodes'

# index_mapping (pick first sb- index)
FIRST_INDEX=$(mcp_call_tool "$MCP_PORT" "index_info" '{"pattern": "sb-*"}' 2>&1 | \
  jq -r '.result.content[0].text' | jq -r '.[0].index // empty')

if [[ -n "$FIRST_INDEX" ]]; then
  RESP=$(mcp_call_tool "$MCP_PORT" "index_mapping" "{\"index\": \"$FIRST_INDEX\"}" 2>&1 || echo '{}')
  CONTENT=$(echo "$RESP" | jq -r '.result.content[0].text // empty')
  if echo "$CONTENT" | jq -e ".[\"$FIRST_INDEX\"]" >/dev/null 2>&1; then
    green "  ✓ index_mapping returns mapping for $FIRST_INDEX"
    ((PASS++))
  else
    red "  ✗ index_mapping missing mapping for $FIRST_INDEX"
    ((FAIL++))
  fi

  # index_settings
  RESP=$(mcp_call_tool "$MCP_PORT" "index_settings" "{\"index\": \"$FIRST_INDEX\"}" 2>&1 || echo '{}')
  CONTENT=$(echo "$RESP" | jq -r '.result.content[0].text // empty')
  assert_json_field "index_settings returns settings" "$CONTENT" ".[\"$FIRST_INDEX\"]"

  # index_stats
  RESP=$(mcp_call_tool "$MCP_PORT" "index_stats" "{\"index\": \"$FIRST_INDEX\"}" 2>&1 || echo '{}')
  CONTENT=$(echo "$RESP" | jq -r '.result.content[0].text // empty')
  assert_json_field "index_stats returns primaries" "$CONTENT" '._all.primaries'

  # field_caps
  RESP=$(mcp_call_tool "$MCP_PORT" "field_caps" "{\"index\": \"$FIRST_INDEX\"}" 2>&1 || echo '{}')
  CONTENT=$(echo "$RESP" | jq -r '.result.content[0].text // empty')
  assert_json_field "field_caps returns fields" "$CONTENT" '.fields'

  # query_profile
  RESP=$(mcp_call_tool "$MCP_PORT" "query_profile" "{\"index\": \"$FIRST_INDEX\", \"query\": {\"match_all\": {}}, \"size\": 0}" 2>&1 || echo '{}')
  CONTENT=$(echo "$RESP" | jq -r '.result.content[0].text // empty')
  assert_json_field "query_profile returns profile" "$CONTENT" '.profile'
else
  yellow "  ⊘ Skipping per-index tools (no sb-* indices found)"
  ((SKIP+=5))
fi

# running_tasks
RESP=$(mcp_call_tool "$MCP_PORT" "running_tasks" '{}' 2>&1 || echo '{}')
CONTENT=$(echo "$RESP" | jq -r '.result.content[0].text // empty')
assert_json_field "running_tasks returns nodes" "$CONTENT" '.nodes'

# allocation_explain
RESP=$(mcp_call_tool "$MCP_PORT" "allocation_explain" '{}' 2>&1 || echo '{}')
CONTENT=$(echo "$RESP" | jq -r '.result.content[0].text // empty')
if [[ -n "$CONTENT" ]]; then
  green "  ✓ allocation_explain returns response"
  ((PASS++))
else
  red "  ✗ allocation_explain returned empty"
  ((FAIL++))
fi

# ── Test 4: Write Tool — Reindex (bad-mapping fix) ──────────────────────────

echo ""
echo "── Test 4: Write Tool — Reindex ──"

SOURCE_INDEX="sb-${SANDBOX_ID}-bad-mapping-logs"
TARGET_INDEX="sb-${SANDBOX_ID}-bad-mapping-logs-fixed"

# Check source exists
SRC_COUNT=$(curl -sf "http://localhost:${ES_PORT}/${SOURCE_INDEX}/_count" \
  -u "elastic:changeme" 2>/dev/null | jq '.count // 0')

if [[ "$SRC_COUNT" -gt 0 ]]; then
  # Reindex with correct mappings
  RESP=$(mcp_call_tool "$MCP_PORT" "reindex" "$(jq -n \
    --arg src "$SOURCE_INDEX" \
    --arg tgt "$TARGET_INDEX" \
    '{
      source_index: $src,
      target_index: $tgt,
      target_mappings: {
        properties: {
          timestamp: { type: "date" },
          duration_ms: { type: "long" },
          service: { type: "keyword" },
          level: { type: "keyword" },
          message: { type: "text" },
          host: { type: "keyword" },
          trace_id: { type: "keyword" }
        }
      }
    }')" 2>&1 || echo '{}')

  CONTENT=$(echo "$RESP" | jq -r '.result.content[0].text // empty')

  # Check reindex succeeded
  if echo "$CONTENT" | jq -e '.created' >/dev/null 2>&1; then
    CREATED=$(echo "$CONTENT" | jq '.created // 0')
    if [[ "$CREATED" -gt 0 ]]; then
      green "  ✓ Reindex created $CREATED docs"
      ((PASS++))
    else
      red "  ✗ Reindex created 0 docs"
      ((FAIL++))
    fi
  elif echo "$CONTENT" | jq -e '.reindex_response.created' >/dev/null 2>&1; then
    CREATED=$(echo "$CONTENT" | jq '.reindex_response.created // 0')
    if [[ "$CREATED" -gt 0 ]]; then
      green "  ✓ Reindex created $CREATED docs"
      ((PASS++))
    else
      red "  ✗ Reindex created 0 docs"
      ((FAIL++))
    fi
  else
    red "  ✗ Reindex response unexpected: $(echo "$CONTENT" | head -c 200)"
    ((FAIL++))
  fi

  # Verify doc count matches
  TGT_COUNT=$(curl -sf "http://localhost:${ES_PORT}/${TARGET_INDEX}/_count" \
    -u "elastic:changeme" 2>/dev/null | jq '.count // 0')
  if [[ "$TGT_COUNT" -eq "$SRC_COUNT" ]]; then
    green "  ✓ Doc count matches: source=$SRC_COUNT target=$TGT_COUNT"
    ((PASS++))
  else
    red "  ✗ Doc count mismatch: source=$SRC_COUNT target=$TGT_COUNT"
    ((FAIL++))
  fi

  # Verify mapping has correct types
  TGT_MAPPING=$(curl -sf "http://localhost:${ES_PORT}/${TARGET_INDEX}/_mapping" \
    -u "elastic:changeme" 2>/dev/null)
  TS_TYPE=$(echo "$TGT_MAPPING" | jq -r ".[\"$TARGET_INDEX\"].mappings.properties.timestamp.type // empty")
  if [[ "$TS_TYPE" == "date" ]]; then
    green "  ✓ timestamp field correctly mapped as date"
    ((PASS++))
  else
    red "  ✗ timestamp field type: $TS_TYPE (expected date)"
    ((FAIL++))
  fi

  # Verify date range query works on target
  DATE_RESP=$(curl -sf "http://localhost:${ES_PORT}/${TARGET_INDEX}/_search" \
    -u "elastic:changeme" \
    -H "Content-Type: application/json" \
    -d '{"query": {"range": {"timestamp": {"gte": "2020-01-01"}}}, "size": 1}' 2>/dev/null)
  DATE_HITS=$(echo "$DATE_RESP" | jq '.hits.total.value // 0')
  if [[ "$DATE_HITS" -gt 0 ]]; then
    green "  ✓ Date range query works on fixed index ($DATE_HITS hits)"
    ((PASS++))
  else
    red "  ✗ Date range query returned 0 hits"
    ((FAIL++))
  fi

  # Clean up the target index
  curl -sf "http://localhost:${ES_PORT}/${TARGET_INDEX}" \
    -u "elastic:changeme" -X DELETE >/dev/null 2>&1 || true
else
  yellow "  ⊘ Skipping reindex test (source index $SOURCE_INDEX not found or empty)"
  ((SKIP+=4))
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════"
printf "  Results: "
green "PASS=$PASS" | tr -d '\n'
printf "  "
if [[ "$FAIL" -gt 0 ]]; then
  red "FAIL=$FAIL" | tr -d '\n'
else
  printf "FAIL=0"
fi
printf "  "
if [[ "$SKIP" -gt 0 ]]; then
  yellow "SKIP=$SKIP"
else
  printf "SKIP=0\n"
fi
echo "═══════════════════════════════════════════════════════"

# ── Cleanup ──────────────────────────────────────────────────────────────────

if [[ -n "$CREATED_SANDBOX" ]]; then
  echo ""
  echo "Cleaning up sandbox: $CREATED_SANDBOX"
  "${SCRIPT_DIR}/sandbox" destroy "$CREATED_SANDBOX" 2>&1 || true
fi

# Exit with failure if any tests failed
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
