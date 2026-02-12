#!/usr/bin/env bash
# over-sharded/data.sh — Load ~500 docs into a 10-shard index (way too few docs per shard)

load_over_sharded_data() {
  local port="$1" id="$2"
  local index="sb-${id}-over-sharded-metrics"

  log "Generating 500 metric documents for $index"

  local hosts=("web-01" "web-02" "db-01" "cache-01" "worker-01")
  local metrics=("cpu_usage" "memory_usage" "disk_io" "network_in" "network_out" "request_latency" "error_rate")
  local tag_sets=("production" "staging" "us-east-1" "us-west-2" "eu-west-1")

  local bulk_data=""
  local batch_size=200
  local total=0

  for i in $(seq 1 500); do
    local host="${hosts[$((RANDOM % ${#hosts[@]}))]}"
    local metric="${metrics[$((RANDOM % ${#metrics[@]}))]}"
    local tag="${tag_sets[$((RANDOM % ${#tag_sets[@]}))]}"
    local value="$((RANDOM % 100)).$((RANDOM % 99))"
    local ts
    ts=$(date -u -v-$((RANDOM % 1440))M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         date -u -d "-$((RANDOM % 1440)) minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         echo "2026-02-12T$(printf '%02d' $((RANDOM % 24))):$(printf '%02d' $((RANDOM % 60))):$(printf '%02d' $((RANDOM % 60)))Z")

    bulk_data+='{"index":{"_index":"'"$index"'"}}'$'\n'
    bulk_data+='{"timestamp":"'"$ts"'","host":"'"$host"'","metric_name":"'"$metric"'","value":'"$value"',"tags":["'"$tag"'"]}'$'\n'

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
