#!/usr/bin/env bash
# bad-replicas/workload.sh — Expose replica misconfiguration via health checks and allocation

workload_bad_replicas() {
  local port="$1" id="$2"
  local index_over="sb-${id}-bad-replicas-overreplicated"
  local index_norep="sb-${id}-bad-replicas-critical-noreplica"

  log "Running bad-replicas workload on $index_over and $index_norep"

  local report
  report=$(report_init "$id" "bad-replicas")

  # ── Query 1: Search over-replicated index (works, but cluster is yellow) ─
  local q1
  q1=$(timed_query "$port" POST "/${index_over}/_search" '{
    "query": { "match_all": {} },
    "size": 5
  }' "search_overreplicated")
  report=$(echo "$report" | report_add_query "$q1")

  # ── Query 2: Search no-replica critical index ──────────────────────────
  local q2
  q2=$(timed_query "$port" POST "/${index_norep}/_search" '{
    "query": { "match_all": {} },
    "size": 5
  }' "search_critical_noreplica")
  report=$(echo "$report" | report_add_query "$q2")

  # ── Query 3: Agg on over-replicated ────────────────────────────────────
  local q3
  q3=$(timed_query "$port" POST "/${index_over}/_search" '{
    "size": 0,
    "aggs": {
      "by_event": {
        "terms": { "field": "event" }
      }
    }
  }' "agg_overreplicated")
  report=$(echo "$report" | report_add_query "$q3")

  # ── Query 4: Agg on critical data ──────────────────────────────────────
  local q4
  q4=$(timed_query "$port" POST "/${index_norep}/_search" '{
    "size": 0,
    "aggs": {
      "by_status": {
        "terms": { "field": "status" }
      },
      "total_revenue": {
        "sum": { "field": "amount" }
      }
    }
  }' "agg_critical_noreplica")
  report=$(echo "$report" | report_add_query "$q4")

  # ── Gather diagnostics ─────────────────────────────────────────────────
  local cluster_health shard_info_over shard_info_norep settings_over settings_norep allocation_explain

  cluster_health=$(es_curl "$port" GET "/_cluster/health" 2>/dev/null)
  shard_info_over=$(es_curl "$port" GET "/_cat/shards/${index_over}?format=json" 2>/dev/null)
  shard_info_norep=$(es_curl "$port" GET "/_cat/shards/${index_norep}?format=json" 2>/dev/null)
  settings_over=$(es_curl "$port" GET "/${index_over}/_settings" 2>/dev/null)
  settings_norep=$(es_curl "$port" GET "/${index_norep}/_settings" 2>/dev/null)

  # Get allocation explanation for unassigned shards
  allocation_explain=$(es_curl "$port" POST "/_cluster/allocation/explain" \
    -d '{"index": "'"$index_over"'", "shard": 0, "primary": false}' 2>/dev/null) || allocation_explain='{}'

  local unassigned_count
  unassigned_count=$(echo "$shard_info_over" | jq '[.[] | select(.state == "UNASSIGNED")] | length')

  local over_replicas norep_replicas
  over_replicas=$(echo "$settings_over" | jq -r 'to_entries[0].value.settings.index.number_of_replicas // "?"')
  norep_replicas=$(echo "$settings_norep" | jq -r 'to_entries[0].value.settings.index.number_of_replicas // "?"')

  local norep_doc_count
  norep_doc_count=$(es_curl "$port" GET "/${index_norep}/_count" 2>/dev/null | jq '.count // 0')

  local diag
  diag=$(jq -n \
    --argjson cluster_health "$cluster_health" \
    --argjson unassigned_shards "$unassigned_count" \
    --arg over_replicas "$over_replicas" \
    --arg norep_replicas "$norep_replicas" \
    --argjson norep_doc_count "$norep_doc_count" \
    --argjson allocation_explain "$allocation_explain" \
    --argjson shards_over "$shard_info_over" \
    --argjson shards_norep "$shard_info_norep" \
    '{
      cluster_health_status: $cluster_health.status,
      cluster_active_shards: $cluster_health.active_shards,
      cluster_unassigned_shards: $cluster_health.unassigned_shards,
      overreplicated: {
        replicas_configured: ($over_replicas | tonumber),
        unassigned_shards: $unassigned_shards,
        shard_states: $shards_over,
        allocation_explain_decision: ($allocation_explain.allocate_explanation // "N/A")
      },
      critical_noreplica: {
        replicas_configured: ($norep_replicas | tonumber),
        doc_count: $norep_doc_count,
        shard_states: $shards_norep,
        data_at_risk: "All \($norep_doc_count) documents have zero redundancy"
      }
    }')
  report=$(echo "$report" | report_set_diagnostics "$diag")

  # ── Finalize ────────────────────────────────────────────────────────────
  report=$(echo "$report" | report_set_summary)
  echo "$report"
}
