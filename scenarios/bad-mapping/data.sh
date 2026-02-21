#!/usr/bin/env bash
# bad-mapping/data.sh — Bulk load ~1000 key store order documents

load_bad_mapping_data() {
  local port="$1" id="$2"
  local index="sb-${id}-orders"

  log "Generating 1000 order documents for $index"

  local key_types=("house" "car" "safe" "padlock" "mailbox" "cabinet" "deadbolt")
  local stores=("main-shop" "downtown" "mobile-van")
  local statuses=("pending" "cutting" "ready" "picked-up")
  local descriptions=(
    "House key copy"
    "Schlage deadbolt rekey"
    "Car key duplicate"
    "Padlock key replacement"
    "Mailbox key copy"
    "Safe combination reset and new key"
    "Cabinet lock rekey"
    "Master key system setup"
    "High-security key cut"
    "Transponder key programming"
  )

  local bulk_data=""

  for i in $(seq 1 1000); do
    local ktype="${key_types[$((RANDOM % ${#key_types[@]}))]}"
    local store="${stores[$((RANDOM % ${#stores[@]}))]}"
    local status="${statuses[$((RANDOM % ${#statuses[@]}))]}"
    local desc="${descriptions[$((RANDOM % ${#descriptions[@]}))]}"
    local price="$((RANDOM % 200 + 5)).$((RANDOM % 99))"
    local cid="cust-$((RANDOM % 500))"
    local ts
    ts=$(date -u -v-$((RANDOM % 1440))M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         date -u -d "-$((RANDOM % 1440)) minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         echo "2026-02-12T$(printf '%02d' $((RANDOM % 24))):$(printf '%02d' $((RANDOM % 60))):$(printf '%02d' $((RANDOM % 60)))Z")

    bulk_data+='{"index":{"_index":"'"$index"'"}}'$'\n'
    bulk_data+='{"order_date":"'"$ts"'","description":"'"$desc"'","key_type":"'"$ktype"'","price":"'"$price"'","status":"'"$status"'","customer_id":"'"$cid"'","store":"'"$store"'"}'$'\n'
  done

  bulk_load "$port" "$bulk_data"

  refresh_index "$port" "$index"
  log "Loaded 1000 documents into $index"
}
