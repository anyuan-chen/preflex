#!/usr/bin/env bash
# es.sh — ES operations: create index, bulk load, settings, license

# ── Wait for security realm ──────────────────────────────────────────────────

wait_for_es_auth() {
  local port="$1" max_wait="${2:-30}"
  local elapsed=0
  while (( elapsed < max_wait )); do
    if es_curl "$port" GET "/_security/_authenticate" 2>/dev/null | jq -e '.username' &>/dev/null; then
      return 0
    fi
    sleep 2
    ((elapsed += 2))
  done
  die "ES security realm not ready after ${max_wait}s"
}

# ── License ─────────────────────────────────────────────────────────────────

activate_trial() {
  local port="$1"
  log "Activating trial license on port $port"
  local resp
  resp=$(es_curl "$port" POST "/_license/start_trial?acknowledge=true" 2>/dev/null) || true
  if echo "$resp" | jq -e '.trial_was_started // .acknowledged' &>/dev/null; then
    log "Trial license activated"
  else
    log "Trial license response: $resp (may already be active)"
  fi
}

# ── Set kibana_system password ──────────────────────────────────────────────

set_kibana_password() {
  local port="$1"
  log "Setting kibana_system password"
  es_curl "$port" POST "/_security/user/kibana_system/_password" \
    -d "{\"password\": \"${ELASTIC_PASSWORD}\"}" >/dev/null
}

# ── Index operations ────────────────────────────────────────────────────────

create_index() {
  # Usage: create_index <port> <index-name> <settings-json>
  local port="$1" index="$2" body="$3"
  log "Creating index: $index"
  local resp
  resp=$(es_curl "$port" PUT "/${index}" -d "$body")
  if echo "$resp" | jq -e '.acknowledged' &>/dev/null; then
    log "Index $index created"
  else
    warn "Index creation response: $resp"
  fi
}

bulk_load() {
  # Usage: bulk_load <port> <ndjson-data>
  # Data should be newline-delimited JSON (action + doc pairs)
  # Note: We use curl directly instead of es_curl because es_curl
  # sets Content-Type: application/json which conflicts with _bulk's
  # required Content-Type: application/x-ndjson.
  local port="$1" data="$2"
  local resp
  resp=$(curl -s -X POST \
    -u "elastic:${ELASTIC_PASSWORD}" \
    -H "Content-Type: application/x-ndjson" \
    "http://localhost:${port}/_bulk" \
    -d "$data")
  local errors
  errors=$(echo "$resp" | jq -r '.errors')
  if [[ "$errors" == "false" ]]; then
    local count
    count=$(echo "$resp" | jq '.items | length')
    log "Bulk loaded $count documents"
  else
    warn "Bulk load had errors: $(echo "$resp" | jq '[.items[] | select(.index.error)] | length') failed"
  fi
}

update_settings() {
  # Usage: update_settings <port> <index> <settings-json>
  local port="$1" index="$2" body="$3"
  log "Updating settings for $index"
  es_curl "$port" PUT "/${index}/_settings" -d "$body" >/dev/null
}

refresh_index() {
  local port="$1" index="$2"
  es_curl "$port" POST "/${index}/_refresh" >/dev/null
}
