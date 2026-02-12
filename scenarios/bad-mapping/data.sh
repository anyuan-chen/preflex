#!/usr/bin/env bash
# bad-mapping/data.sh — Bulk load ~1000 realistic log documents

load_bad_mapping_data() {
  local port="$1" id="$2"
  local index="sb-${id}-bad-mapping-logs"

  log "Generating 1000 log documents for $index"

  local services=("api-gateway" "auth-service" "user-service" "payment-service" "notification-service")
  local paths=("/api/v1/users" "/api/v1/auth/login" "/api/v1/payments" "/api/v1/notifications" "/health" "/api/v1/orders" "/api/v1/products")
  local status_codes=("200" "201" "400" "401" "403" "404" "500" "502" "503")
  local messages=(
    "Request processed successfully"
    "User authentication failed"
    "Database connection timeout"
    "Rate limit exceeded"
    "Cache miss for key"
    "Upstream service unavailable"
    "Request validation error"
    "Payment processed"
    "Notification sent"
    "Health check passed"
  )

  local bulk_data=""
  local batch_size=200
  local total=0

  for i in $(seq 1 1000); do
    local svc="${services[$((RANDOM % ${#services[@]}))]}"
    local path="${paths[$((RANDOM % ${#paths[@]}))]}"
    local code="${status_codes[$((RANDOM % ${#status_codes[@]}))]}"
    local msg="${messages[$((RANDOM % ${#messages[@]}))]}"
    local dur="$((RANDOM % 5000)).$((RANDOM % 99))"
    local uid="user-$((RANDOM % 500))"
    # Generate a timestamp in the last 24 hours
    local ts
    ts=$(date -u -v-$((RANDOM % 1440))M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         date -u -d "-$((RANDOM % 1440)) minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         echo "2026-02-12T$(printf '%02d' $((RANDOM % 24))):$(printf '%02d' $((RANDOM % 60))):$(printf '%02d' $((RANDOM % 60)))Z")

    bulk_data+='{"index":{"_index":"'"$index"'"}}'$'\n'
    bulk_data+='{"timestamp":"'"$ts"'","message":"'"$msg"'","service":"'"$svc"'","duration_ms":"'"$dur"'","status_code":"'"$code"'","user_id":"'"$uid"'","path":"'"$path"'"}'$'\n'

    ((total++))
    if (( total % batch_size == 0 )); then
      bulk_load "$port" "$bulk_data"
      bulk_data=""
    fi
  done

  # Load remaining
  if [[ -n "$bulk_data" ]]; then
    bulk_load "$port" "$bulk_data"
  fi

  refresh_index "$port" "$index"
  log "Loaded $total documents into $index"
}
