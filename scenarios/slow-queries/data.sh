#!/usr/bin/env bash
# slow-queries/data.sh — Load locksmith service log data for the slow query scenario

load_slow_queries_data() {
  local port="$1" id="$2"
  local index="sb-${id}-service-logs"

  log "Generating 800 service log documents for $index"

  local service_types=("key-cutting" "lockout" "rekey" "safe-install")
  local technicians=("tech-001" "tech-002" "tech-003" "tech-004")
  local messages=(
    "Customer locked out, deadbolt rekey completed"
    "Key cutting for Schlage SC1 blank"
    "Emergency lockout service, picked wafer lock"
    "Safe combination reset and new key cut"
    "Transponder key programming for Honda Civic"
    "Master key system installation for office building"
    "Broken key extraction from Yale deadbolt"
    "High-security Medeco key duplication"
    "Cabinet lock rekey, 4 locks total"
    "Automotive lockout, slim jim entry"
  )

  local bulk_data=""

  for i in $(seq 1 800); do
    local stype="${service_types[$((RANDOM % ${#service_types[@]}))]}"
    local tech="${technicians[$((RANDOM % ${#technicians[@]}))]}"
    local msg="${messages[$((RANDOM % ${#messages[@]}))]}"
    local dur="$((RANDOM % 5000)).$((RANDOM % 99))"
    local job="job-$(printf '%08x' $((RANDOM * RANDOM)))"
    local ts
    ts=$(date -u -v-$((RANDOM % 1440))M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         date -u -d "-$((RANDOM % 1440)) minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         echo "2026-02-12T$(printf '%02d' $((RANDOM % 24))):$(printf '%02d' $((RANDOM % 60))):$(printf '%02d' $((RANDOM % 60)))Z")

    bulk_data+='{"index":{"_index":"'"$index"'"}}'$'\n'
    bulk_data+='{"timestamp":"'"$ts"'","message":"'"$msg"'","service_type":"'"$stype"'","technician":"'"$tech"'","job_id":"'"$job"'","duration_ms":'"$dur"'}'$'\n'
  done

  bulk_load "$port" "$bulk_data"

  refresh_index "$port" "$index"
  log "Loaded 800 documents into $index"
}
