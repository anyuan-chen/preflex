#!/usr/bin/env bash
# common.sh — Logging, ID generation, config loading, curl helpers

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOXES_DIR="${SCRIPT_DIR}/sandboxes"

# ── Logging ─────────────────────────────────────────────────────────────────

log()  { printf '[sandbox] %s\n' "$*" >&2; }
warn() { printf '[sandbox] WARN: %s\n' "$*" >&2; }
die()  { printf '[sandbox] ERROR: %s\n' "$*" >&2; exit 1; }

# ── Config loading ──────────────────────────────────────────────────────────

load_config() {
  local conf="${SCRIPT_DIR}/sandbox.conf"
  [[ -f "$conf" ]] || die "Config file not found: $conf"
  # shellcheck source=sandbox.conf
  source "$conf"

  # Load secrets from .env if present (API keys, etc.)
  local env_file="${SCRIPT_DIR}/.env"
  if [[ -f "$env_file" ]]; then
    set -a
    source "$env_file"
    set +a
  fi
}

# ── ID generation ───────────────────────────────────────────────────────────

generate_id() {
  # 4-char hex: 65k possible IDs, plenty for local sandboxes
  openssl rand -hex 2
}

# ── Curl helpers ────────────────────────────────────────────────────────────

es_curl() {
  # Usage: es_curl <port> <method> <path> [curl-args...]
  local port="$1" method="$2" path="$3"
  shift 3
  curl -s -X "$method" \
    -u "elastic:${ELASTIC_PASSWORD}" \
    -H "Content-Type: application/json" \
    "http://localhost:${port}${path}" \
    "$@"
}

kb_curl() {
  # Usage: kb_curl <port> <method> <path> [curl-args...]
  local port="$1" method="$2" path="$3"
  shift 3
  curl -s -X "$method" \
    -u "elastic:${ELASTIC_PASSWORD}" \
    -H "Content-Type: application/json" \
    -H "kbn-xsrf: true" \
    "http://localhost:${port}${path}" \
    "$@"
}

kb_curl_internal() {
  # Like kb_curl but adds x-elastic-internal-origin header for /internal/ APIs
  local port="$1" method="$2" path="$3"
  shift 3
  curl -s -X "$method" \
    -u "elastic:${ELASTIC_PASSWORD}" \
    -H "Content-Type: application/json" \
    -H "kbn-xsrf: true" \
    -H "x-elastic-internal-origin: kibana" \
    "http://localhost:${port}${path}" \
    "$@"
}

# ── Port allocation ────────────────────────────────────────────────────────

port_in_use() {
  # Check if a port is actually bound on the host
  lsof -iTCP:"$1" -sTCP:LISTEN &>/dev/null
}

find_available_ports() {
  # Find next available ES port (skip ports in use on host)
  local es_port="$ES_PORT_BASE"
  while port_in_use "$es_port"; do
    ((es_port++))
  done

  # Find next available Kibana port
  local kb_port="$KIBANA_PORT_BASE"
  while port_in_use "$kb_port"; do
    ((kb_port++))
  done

  # Find next available MCP port
  local mcp_port="$MCP_PORT_BASE"
  while port_in_use "$mcp_port"; do
    ((mcp_port++))
  done

  echo "${es_port} ${kb_port} ${mcp_port}"
}
