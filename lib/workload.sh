#!/usr/bin/env bash
# workload.sh — Shared workload runner utilities: timing, report building

# ── Timing ──────────────────────────────────────────────────────────────────

timed_query() {
  # Run an ES query and capture response + latency.
  # Usage: timed_query <port> <method> <path> <body> <label>
  # Outputs JSON: { "label": "...", "took_ms": N, "status": N, "error": "...", "hits": N }
  local port="$1" method="$2" path="$3" body="$4" label="$5"

  local start_ns end_ns elapsed_ms http_code resp tmp_file
  tmp_file=$(mktemp)

  start_ns=$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')

  http_code=$(curl -s -o "$tmp_file" -w '%{http_code}' \
    -X "$method" \
    -u "elastic:${ELASTIC_PASSWORD}" \
    -H "Content-Type: application/json" \
    "http://localhost:${port}${path}" \
    -d "$body" 2>/dev/null) || http_code="000"

  end_ns=$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')
  elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))

  resp=$(cat "$tmp_file")
  rm -f "$tmp_file"

  local took_es hits error
  took_es=$(echo "$resp" | jq -r '.took // empty' 2>/dev/null) || took_es=""
  hits=$(echo "$resp" | jq -r '.hits.total.value // .hits.total // 0' 2>/dev/null) || hits="0"
  error=$(echo "$resp" | jq -r '
    if .error then
      (.error.root_cause[0].reason // .error.reason // (.error | tostring))
    else empty end' 2>/dev/null) || error=""

  jq -n \
    --arg label "$label" \
    --argjson wall_ms "$elapsed_ms" \
    --argjson took_ms "${took_es:-0}" \
    --argjson http_code "$http_code" \
    --argjson hits "$hits" \
    --arg error "$error" \
    '{
      label: $label,
      wall_ms: $wall_ms,
      took_ms: $took_ms,
      http_code: $http_code,
      hits: $hits,
      error: (if $error == "" then null else $error end)
    }'
}

# ── Report building ────────────────────────────────────────────────────────

report_init() {
  # Start a new workload report. Outputs initial JSON to stdout.
  local id="$1" scenario="$2"
  jq -n \
    --arg id "$id" \
    --arg scenario "$scenario" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
      sandbox_id: $id,
      scenario: $scenario,
      started_at: $ts,
      queries: [],
      diagnostics: {},
      summary: {}
    }'
}

report_add_query() {
  # Append a timed_query result to the report.
  # Usage: echo "$report" | report_add_query "$query_result"
  local query_json="$1"
  jq --argjson q "$query_json" '.queries += [$q]'
}

report_set_diagnostics() {
  # Set the diagnostics section.
  # Usage: echo "$report" | report_set_diagnostics "$diag_json"
  local diag_json="$1"
  jq --argjson d "$diag_json" '.diagnostics = $d'
}

report_set_summary() {
  # Set the summary section from query results.
  # Usage: echo "$report" | report_set_summary
  jq '{
    sandbox_id, scenario, started_at, queries, diagnostics,
    summary: {
      total_queries: (.queries | length),
      errors: [.queries[] | select(.error != null) | .label],
      avg_wall_ms: (if (.queries | length) > 0 then ([.queries[].wall_ms] | add / length | round) else 0 end),
      max_wall_ms: (if (.queries | length) > 0 then ([.queries[].wall_ms] | max) else 0 end),
      completed_at: (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
    }
  }'
}

# ── Scenario workload dispatch ─────────────────────────────────────────────

run_scenario_workload() {
  local scenario="$1" port="$2" id="$3"
  local workload_script="${SCRIPT_DIR}/scenarios/${scenario}/workload.sh"
  [[ -f "$workload_script" ]] || die "Workload script not found: $workload_script"
  source "$workload_script"

  case "$scenario" in
    bad-mapping)    workload_bad_mapping "$port" "$id" ;;
    over-sharded)   workload_over_sharded "$port" "$id" ;;
    slow-queries)   workload_slow_queries "$port" "$id" ;;
    bad-replicas)   workload_bad_replicas "$port" "$id" ;;
    *)              die "Unknown scenario workload: $scenario" ;;
  esac
}
