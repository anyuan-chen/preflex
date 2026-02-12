#!/usr/bin/env bash
# over-sharded/workload.sh — Show shard overhead and search fan-out cost

workload_over_sharded() {
  local port="$1" id="$2"
  local index="sb-${id}-over-sharded-metrics"

  log "Running over-sharded workload on $index"

  local report
  report=$(report_init "$id" "over-sharded")

  # ── Query 1: Simple search to measure fan-out overhead ──────────────────
  local q1
  q1=$(timed_query "$port" POST "/${index}/_search" '{
    "query": { "match_all": {} },
    "size": 10
  }' "match_all_10_shards")
  report=$(echo "$report" | report_add_query "$q1")

  # ── Query 2: Terms agg that must hit all shards ─────────────────────────
  local q2
  q2=$(timed_query "$port" POST "/${index}/_search" '{
    "size": 0,
    "aggs": {
      "by_host": {
        "terms": { "field": "host" }
      }
    }
  }' "terms_agg_all_shards")
  report=$(echo "$report" | report_add_query "$q2")

  # ── Query 3: Date histogram across all shards ──────────────────────────
  local q3
  q3=$(timed_query "$port" POST "/${index}/_search" '{
    "size": 0,
    "aggs": {
      "over_time": {
        "date_histogram": {
          "field": "timestamp",
          "calendar_interval": "hour"
        }
      }
    }
  }' "date_histogram_all_shards")
  report=$(echo "$report" | report_add_query "$q3")

  # ── Query 4: Filtered search ───────────────────────────────────────────
  local q4
  q4=$(timed_query "$port" POST "/${index}/_search" '{
    "query": {
      "bool": {
        "filter": [
          { "term": { "host": "web-01" } },
          { "term": { "metric_name": "cpu_usage" } }
        ]
      }
    },
    "size": 10
  }' "filtered_search_all_shards")
  report=$(echo "$report" | report_add_query "$q4")

  # ── Gather diagnostics ─────────────────────────────────────────────────
  local shard_info index_stats settings

  shard_info=$(es_curl "$port" GET "/_cat/shards/${index}?format=json" 2>/dev/null)
  index_stats=$(es_curl "$port" GET "/${index}/_stats" 2>/dev/null)
  settings=$(es_curl "$port" GET "/${index}/_settings" 2>/dev/null)

  local total_docs total_size_bytes num_shards docs_per_shard
  total_docs=$(echo "$index_stats" | jq '.indices["'"$index"'"].primaries.docs.count // 0')
  total_size_bytes=$(echo "$index_stats" | jq '.indices["'"$index"'"].primaries.store.size_in_bytes // 0')
  num_shards=$(echo "$shard_info" | jq '[.[] | select(.prirep == "p")] | length')
  docs_per_shard=$(( total_docs / (num_shards > 0 ? num_shards : 1) ))

  local diag
  diag=$(jq -n \
    --argjson shards "$shard_info" \
    --argjson total_docs "$total_docs" \
    --argjson total_size_bytes "$total_size_bytes" \
    --argjson num_primary_shards "$num_shards" \
    --argjson docs_per_shard "$docs_per_shard" \
    --argjson settings "$settings" \
    '{
      shards: $shards,
      total_docs: $total_docs,
      total_size_bytes: $total_size_bytes,
      num_primary_shards: $num_primary_shards,
      docs_per_shard: $docs_per_shard,
      bytes_per_shard: (if $num_primary_shards > 0 then ($total_size_bytes / $num_primary_shards | round) else 0 end),
      settings: $settings,
      assessment: (
        if $docs_per_shard < 100 then "SEVERELY over-sharded: \($docs_per_shard) docs per shard"
        elif $docs_per_shard < 10000 then "Over-sharded: \($docs_per_shard) docs per shard"
        else "Shard count looks reasonable"
        end
      )
    }')
  report=$(echo "$report" | report_set_diagnostics "$diag")

  # ── Finalize ────────────────────────────────────────────────────────────
  report=$(echo "$report" | report_set_summary)
  echo "$report"
}
