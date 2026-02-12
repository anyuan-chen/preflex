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

# ── Port allocation ────────────────────────────────────────────────────────

find_available_ports() {
  local used_es_ports=() used_kb_ports=() used_mcp_ports=()

  # Scan existing manifests for used ports
  if [[ -d "$SANDBOXES_DIR" ]]; then
    for manifest in "$SANDBOXES_DIR"/*/manifest.json; do
      [[ -f "$manifest" ]] || continue
      used_es_ports+=("$(jq -r '.es_port' "$manifest")")
      used_kb_ports+=("$(jq -r '.kibana_port' "$manifest")")
      used_mcp_ports+=("$(jq -r '.mcp_port // empty' "$manifest")")
    done
  fi

  # Find next available ES port
  local es_port="$ES_PORT_BASE"
  while printf '%s\n' "${used_es_ports[@]}" 2>/dev/null | grep -qx "$es_port"; do
    ((es_port++))
  done

  # Find next available Kibana port
  local kb_port="$KIBANA_PORT_BASE"
  while printf '%s\n' "${used_kb_ports[@]}" 2>/dev/null | grep -qx "$kb_port"; do
    ((kb_port++))
  done

  # Find next available MCP port
  local mcp_port="$MCP_PORT_BASE"
  while printf '%s\n' "${used_mcp_ports[@]}" 2>/dev/null | grep -qx "$mcp_port"; do
    ((mcp_port++))
  done

  echo "${es_port} ${kb_port} ${mcp_port}"
}
