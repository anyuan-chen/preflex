#!/usr/bin/env bash
# bad-replicas/workload.sh — Expose replica misconfiguration via health checks and allocation

workload_bad_replicas() {
  local port="$1" id="$2"
  local index_appt="sb-${id}-appointments"
  local index_bill="sb-${id}-customer-billing"

  log "Running bad-replicas workload on $index_appt and $index_bill"

  local report
  report=$(report_init "$id" "bad-replicas")

  # ── Query 1: Search over-replicated index (works, but cluster is yellow) ─
  local q1
  q1=$(timed_query "$port" POST "/${index_appt}/_search" '{
    "query": { "match_all": {} },
    "size": 5
  }' "search_appointments")
  report=$(echo "$report" | report_add_query "$q1")

  # ── Query 2: Search no-replica critical index ──────────────────────────
  local q2
  q2=$(timed_query "$port" POST "/${index_bill}/_search" '{
    "query": { "match_all": {} },
    "size": 5
  }' "search_billing")
  report=$(echo "$report" | report_add_query "$q2")

  # ── Query 3: Agg on appointments ─────────────────────────────────────
  local q3
  q3=$(timed_query "$port" POST "/${index_appt}/_search" '{
    "size": 0,
    "aggs": {
      "by_event": {
        "terms": { "field": "event" }
      }
    }
  }' "agg_appointments")
  report=$(echo "$report" | report_add_query "$q3")

  # ── Query 4: Agg on billing data ─────────────────────────────────────
  local q4
  q4=$(timed_query "$port" POST "/${index_bill}/_search" '{
    "size": 0,
    "aggs": {
      "by_status": {
        "terms": { "field": "status" }
      },
      "total_revenue": {
        "sum": { "field": "amount" }
      }
    }
  }' "agg_billing")
  report=$(echo "$report" | report_add_query "$q4")

  # ── Gather diagnostics ─────────────────────────────────────────────────
  local cluster_health shard_info_appt shard_info_bill settings_appt settings_bill allocation_explain

  cluster_health=$(es_curl "$port" GET "/_cluster/health" 2>/dev/null)
  shard_info_appt=$(es_curl "$port" GET "/_cat/shards/${index_appt}?format=json" 2>/dev/null)
  shard_info_bill=$(es_curl "$port" GET "/_cat/shards/${index_bill}?format=json" 2>/dev/null)
  settings_appt=$(es_curl "$port" GET "/${index_appt}/_settings" 2>/dev/null)
  settings_bill=$(es_curl "$port" GET "/${index_bill}/_settings" 2>/dev/null)

  # Get allocation explanation for unassigned shards
  allocation_explain=$(es_curl "$port" POST "/_cluster/allocation/explain" \
    -d '{"index": "'"$index_appt"'", "shard": 0, "primary": false}' 2>/dev/null) || allocation_explain='{}'

  local unassigned_count
  unassigned_count=$(echo "$shard_info_appt" | jq '[.[] | select(.state == "UNASSIGNED")] | length')

  local appt_replicas bill_replicas
  appt_replicas=$(echo "$settings_appt" | jq -r 'to_entries[0].value.settings.index.number_of_replicas // "?"')
  bill_replicas=$(echo "$settings_bill" | jq -r 'to_entries[0].value.settings.index.number_of_replicas // "?"')

  local bill_doc_count
  bill_doc_count=$(es_curl "$port" GET "/${index_bill}/_count" 2>/dev/null | jq '.count // 0')

  local diag
  diag=$(jq -n \
    --argjson cluster_health "$cluster_health" \
    --argjson unassigned_shards "$unassigned_count" \
    --arg appt_replicas "$appt_replicas" \
    --arg bill_replicas "$bill_replicas" \
    --argjson bill_doc_count "$bill_doc_count" \
    --argjson allocation_explain "$allocation_explain" \
    --argjson shards_appt "$shard_info_appt" \
    --argjson shards_bill "$shard_info_bill" \
    '{
      cluster_health_status: $cluster_health.status,
      cluster_active_shards: $cluster_health.active_shards,
      cluster_unassigned_shards: $cluster_health.unassigned_shards,
      appointments: {
        replicas_configured: ($appt_replicas | tonumber),
        unassigned_shards: $unassigned_shards,
        shard_states: $shards_appt,
        allocation_explain_decision: ($allocation_explain.allocate_explanation // "N/A")
      },
      customer_billing: {
        replicas_configured: ($bill_replicas | tonumber),
        doc_count: $bill_doc_count,
        shard_states: $shards_bill,
        data_at_risk: "All \($bill_doc_count) invoices have zero redundancy"
      }
    }')
  report=$(echo "$report" | report_set_diagnostics "$diag")

  # ── Finalize ────────────────────────────────────────────────────────────
  report=$(echo "$report" | report_set_summary)
  echo "$report"
}
