#!/usr/bin/env bash
# manifest.sh — Manifest CRUD (read/write sandbox state to disk)

manifest_dir() {
  local id="$1"
  echo "${SANDBOXES_DIR}/sb-${id}"
}

manifest_path() {
  local id="$1"
  echo "$(manifest_dir "$id")/manifest.json"
}

manifest_init() {
  local id="$1" es_port="$2" kb_port="$3"
  shift 3
  local scenarios=("$@")

  local dir
  dir="$(manifest_dir "$id")"
  mkdir -p "$dir"

  local scenarios_json
  scenarios_json=$(printf '%s\n' "${scenarios[@]}" | jq -R . | jq -s .)

  jq -n \
    --arg id "$id" \
    --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson es_port "$es_port" \
    --argjson kb_port "$kb_port" \
    --arg es_container "sb-${id}-es" \
    --arg kb_container "sb-${id}-kb" \
    --argjson scenarios "$scenarios_json" \
    '{
      id: $id,
      created_at: $created,
      es_port: $es_port,
      kibana_port: $kb_port,
      es_container: $es_container,
      kibana_container: $kb_container,
      scenarios: $scenarios,
      agent_id: null,
      tools: [],
      golden: {}
    }' > "$(manifest_path "$id")"

  log "Manifest created: $(manifest_path "$id")"
}

manifest_read() {
  local id="$1"
  local path
  path="$(manifest_path "$id")"
  [[ -f "$path" ]] || die "Manifest not found for sandbox $id"
  cat "$path"
}

manifest_get() {
  # Usage: manifest_get <id> <jq-field>
  local id="$1" field="$2"
  manifest_read "$id" | jq -r "$field"
}

manifest_update() {
  # Usage: manifest_update <id> [jq-args...] <jq-filter>
  # Example: manifest_update "abc" --arg key "val" '.field = $key'
  local id="$1"
  shift
  local path
  path="$(manifest_path "$id")"
  local tmp="${path}.tmp"
  jq "$@" "$path" > "$tmp" && mv "$tmp" "$path"
}

manifest_merge_golden() {
  local id="$1" golden_file="$2"
  [[ -f "$golden_file" ]] || return 0
  local path
  path="$(manifest_path "$id")"
  local tmp="${path}.tmp"
  jq --slurpfile g "$golden_file" '.golden = (.golden + $g[0])' "$path" > "$tmp" && mv "$tmp" "$path"
}

manifest_list_ids() {
  for manifest in "$SANDBOXES_DIR"/sb-*/manifest.json; do
    [[ -f "$manifest" ]] || continue
    jq -r '.id' "$manifest"
  done
}
