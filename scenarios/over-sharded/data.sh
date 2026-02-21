#!/usr/bin/env bash
# over-sharded/data.sh — Load ~500 docs into a 10-shard index (way too few docs per shard)

load_over_sharded_data() {
  local port="$1" id="$2"
  local index="sb-${id}-key-inventory"

  log "Generating 500 inventory documents for $index"

  local brands=("Kwikset" "Schlage" "Yale" "Medeco" "Master")
  local key_types=("blank" "cut" "master" "restricted")
  local locations=("main-shop" "workshop" "mobile-van" "warehouse")
  local prefixes=("KW1" "SC1" "SC4" "YL5" "MED" "M1" "KW10" "BE2")

  local bulk_data=""

  for i in $(seq 1 500); do
    local brand="${brands[$((RANDOM % ${#brands[@]}))]}"
    local ktype="${key_types[$((RANDOM % ${#key_types[@]}))]}"
    local loc="${locations[$((RANDOM % ${#locations[@]}))]}"
    local prefix="${prefixes[$((RANDOM % ${#prefixes[@]}))]}"
    local material
    case $((RANDOM % 3)) in
      0) material="BRASS" ;;
      1) material="NICKEL" ;;
      2) material="STEEL" ;;
    esac
    local sku="${prefix}-${material}-$(printf '%03d' $((RANDOM % 999)))"
    local qty="$((RANDOM % 200))"
    local ts
    ts=$(date -u -v-$((RANDOM % 1440))M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         date -u -d "-$((RANDOM % 1440)) minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         echo "2026-02-12T$(printf '%02d' $((RANDOM % 24))):$(printf '%02d' $((RANDOM % 60))):$(printf '%02d' $((RANDOM % 60)))Z")

    bulk_data+='{"index":{"_index":"'"$index"'"}}'$'\n'
    bulk_data+='{"timestamp":"'"$ts"'","sku":"'"$sku"'","brand":"'"$brand"'","key_type":"'"$ktype"'","quantity":'"$qty"',"location":"'"$loc"'"}'$'\n'
  done

  bulk_load "$port" "$bulk_data"

  refresh_index "$port" "$index"
  log "Loaded 500 documents into $index"
}
