#!/usr/bin/env bash
# mcp.sh — MCP server lifecycle management

MCP_DIR="${SCRIPT_DIR}/mcp-server"

# ── Build MCP server if needed ─────────────────────────────────────────────

ensure_mcp_built() {
  local hash_file="${MCP_DIR}/.build-hash"

  # Hash source files + package.json + tsconfig
  local current_hash
  current_hash=$(find "${MCP_DIR}/src" -type f -print0 | sort -z | xargs -0 cat | \
    cat - "${MCP_DIR}/package.json" "${MCP_DIR}/tsconfig.json" | shasum -a 256 | cut -d' ' -f1)

  # Check if cached hash matches
  if [[ -f "$hash_file" ]] && [[ -f "${MCP_DIR}/dist/index.js" ]]; then
    local cached_hash
    cached_hash=$(cat "$hash_file")
    if [[ "$cached_hash" == "$current_hash" ]]; then
      log "MCP server build is up to date (cached)"
      return 0
    fi
  fi

  # Install deps if needed
  if [[ ! -d "${MCP_DIR}/node_modules" ]]; then
    log "Installing MCP server dependencies..."
    (cd "$MCP_DIR" && npm install --silent) || die "npm install failed for MCP server"
  fi

  # Rebuild
  log "Building MCP server..."
  (cd "$MCP_DIR" && npm run build --silent) || die "MCP server build failed"

  # Save hash
  echo "$current_hash" > "$hash_file"
}

# ── Start MCP server ──────────────────────────────────────────────────────

start_mcp_server() {
  local id="$1" es_port="$2" mcp_port="$3" verify_mode="${4:-auto}"

  ensure_mcp_built

  local log_file
  log_file="$(manifest_dir "$id")/mcp-server.log"

  local kb_port="${5:-5601}"

  ES_URL="http://localhost:${es_port}" \
  ES_USER="elastic" \
  ES_PASSWORD="${ELASTIC_PASSWORD}" \
  MCP_PORT="$mcp_port" \
  VERIFY_MODE="$verify_mode" \
  KIBANA_URL="http://localhost:${kb_port}" \
  AGENT_ID="${AGENT_ID:-optimizer}" \
  MONITOR_ENABLED="${MONITOR_ENABLED:-true}" \
  MONITOR_INTERVAL_MS="${MONITOR_INTERVAL_MS:-10000}" \
  SLACK_TOKEN="${SLACK_TOKEN:-}" \
  SLACK_CHANNEL="${SLACK_CHANNEL:-}" \
  nohup node "${MCP_DIR}/dist/index.js" > "$log_file" 2>&1 &

  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid"
}

# ── Stop MCP server ───────────────────────────────────────────────────────

stop_mcp_server() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    # Wait briefly for clean shutdown
    local i=0
    while kill -0 "$pid" 2>/dev/null && (( i < 10 )); do
      sleep 0.5
      ((i++))
    done
    # Force kill if still running
    kill -9 "$pid" 2>/dev/null || true
    log "MCP server (pid $pid) stopped"
  fi
}

# ── Wait for MCP server to be ready ───────────────────────────────────────

wait_for_mcp() {
  local mcp_port="$1"
  local max_wait=30 elapsed=0

  log "Waiting for MCP server on port $mcp_port..."

  while ! curl -sf "http://127.0.0.1:${mcp_port}/mcp" -X POST \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"0.1"}}}' \
    >/dev/null 2>&1; do
    sleep 1
    ((elapsed++))
    if (( elapsed >= max_wait )); then
      warn "MCP server failed to start on port $mcp_port (waited ${max_wait}s)"
      return 1
    fi
  done

  log "MCP server ready on port $mcp_port"
}

# ── Get MCP URL for Kibana connector ──────────────────────────────────────

get_mcp_url_for_kibana() {
  local mcp_port="$1"

  # Kibana runs in Docker, MCP server runs on host
  # macOS: host.docker.internal works
  # Linux: need to use Docker bridge gateway
  if [[ "$(uname)" == "Darwin" ]]; then
    echo "http://host.docker.internal:${mcp_port}/mcp"
  else
    # Get Docker bridge gateway IP
    local gateway
    gateway=$(docker network inspect "${DOCKER_NETWORK}" --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null)
    if [[ -n "$gateway" ]]; then
      echo "http://${gateway}:${mcp_port}/mcp"
    else
      # Fallback
      echo "http://172.17.0.1:${mcp_port}/mcp"
    fi
  fi
}
