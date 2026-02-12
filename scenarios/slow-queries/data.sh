#!/usr/bin/env bash
# slow-queries/data.sh — Load log data for the slow query scenario

load_slow_queries_data() {
  local port="$1" id="$2"
  local index="sb-${id}-slow-query-logs"

  log "Generating 800 log documents for $index"

  local services=("api-gateway" "auth-service" "order-service" "inventory-service")
  local levels=("INFO" "WARN" "ERROR" "DEBUG")
  local messages=(
    "Connection timeout after 30s"
    "Request processed successfully"
    "Failed to authenticate user"
    "Cache miss for session key"
    "Database query returned 0 results"
    "Upstream service returned 503"
    "Rate limit reached for client"
    "Retrying failed operation attempt 3"
    "Memory pressure above threshold"
    "Garbage collection pause detected"
  )

  local bulk_data=""
  local batch_size=200
  local total=0

  for i in $(seq 1 800); do
    local svc="${services[$((RANDOM % ${#services[@]}))]}"
    local level="${levels[$((RANDOM % ${#levels[@]}))]}"
    local msg="${messages[$((RANDOM % ${#messages[@]}))]}"
    local dur="$((RANDOM % 5000)).$((RANDOM % 99))"
    local trace="trace-$(printf '%08x' $((RANDOM * RANDOM)))"
    local ts
    ts=$(date -u -v-$((RANDOM % 1440))M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         date -u -d "-$((RANDOM % 1440)) minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         echo "2026-02-12T$(printf '%02d' $((RANDOM % 24))):$(printf '%02d' $((RANDOM % 60))):$(printf '%02d' $((RANDOM % 60)))Z")

    bulk_data+='{"index":{"_index":"'"$index"'"}}'$'\n'
    bulk_data+='{"timestamp":"'"$ts"'","message":"'"$msg"'","service":"'"$svc"'","level":"'"$level"'","trace_id":"'"$trace"'","duration_ms":'"$dur"'}'$'\n'

    ((total++))
    if (( total % batch_size == 0 )); then
      bulk_load "$port" "$bulk_data"
      bulk_data=""
    fi
  done

  if [[ -n "$bulk_data" ]]; then
    bulk_load "$port" "$bulk_data"
  fi

  refresh_index "$port" "$index"
  log "Loaded $total documents into $index"
}
