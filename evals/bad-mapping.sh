#!/usr/bin/env bash
# evals/bad-mapping.sh — Realtime eval: field type mapping problems
#
# Story: An analytics team starts querying a new orders index.
#   Phase 1 (warmup):  Simple match_all and keyword filters — things look fine.
#   Phase 2 (analysts): Analysts build dashboards — date histograms, aggs by key_type,
#                        numeric sorts. Errors and wrong results start appearing.
#   Phase 3 (dashboard): Full dashboard load — every query type at once. Everything breaks.

eval_bad_mapping() {
  local port="$1" id="$2"
  local index="sb-${id}-orders"

  # ── Query pools ───────────────────────────────────────────────────────────

  pool_warmup() {
    local queries=(
      "match_all|POST|/${index}/_search|{\"query\":{\"match_all\":{}},\"size\":5}"
      "match_all_20|POST|/${index}/_search|{\"query\":{\"match_all\":{}},\"size\":20}"
      "count|POST|/${index}/_count|{\"query\":{\"match_all\":{}}}"
      "exists_check|POST|/${index}/_search|{\"query\":{\"exists\":{\"field\":\"description\"}},\"size\":3}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  pool_analysts() {
    # Mix of queries that work and queries that break due to bad mappings
    local queries=(
      # These break: date range on text
      "date_range|POST|/${index}/_search|{\"query\":{\"range\":{\"order_date\":{\"gte\":\"2026-02-11\",\"lte\":\"2026-02-13\"}}},\"size\":5}"
      # These break: date histogram on text
      "date_histogram|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"over_time\":{\"date_histogram\":{\"field\":\"order_date\",\"calendar_interval\":\"hour\"}}}}"
      # These break: terms agg on text key_type
      "agg_by_service|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"by_service\":{\"terms\":{\"field\":\"key_type\"}}}}"
      # These break: numeric sort on text
      "sort_duration|POST|/${index}/_search|{\"sort\":[{\"price\":\"desc\"}],\"size\":10}"
      # These still work
      "match_all|POST|/${index}/_search|{\"query\":{\"match_all\":{}},\"size\":5}"
      "count|POST|/${index}/_count|{\"query\":{\"match_all\":{}}}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  pool_dashboard() {
    # Heavy dashboard-style queries — almost all break
    local queries=(
      "date_histogram|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"over_time\":{\"date_histogram\":{\"field\":\"order_date\",\"calendar_interval\":\"minute\"}}}}"
      "agg_by_service|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"by_service\":{\"terms\":{\"field\":\"key_type\",\"size\":20}}}}"
      "agg_by_status|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"by_status\":{\"terms\":{\"field\":\"status\",\"size\":10}}}}"
      "sort_duration|POST|/${index}/_search|{\"sort\":[{\"price\":\"desc\"}],\"size\":20,\"_source\":[\"price\",\"key_type\",\"order_date\"]}"
      "range_duration|POST|/${index}/_search|{\"query\":{\"range\":{\"price\":{\"gte\":1000}}},\"size\":10}"
      "date_range|POST|/${index}/_search|{\"query\":{\"range\":{\"order_date\":{\"gte\":\"2026-02-12T00:00:00Z\",\"lte\":\"2026-02-12T23:59:59Z\"}}},\"size\":10}"
      "fulltext_message|POST|/${index}/_search|{\"query\":{\"match\":{\"description\":\"timeout\"}},\"size\":10}"
      "agg_avg_duration|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"avg_dur\":{\"avg\":{\"field\":\"price\"}}}}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  # ── Phase definitions ─────────────────────────────────────────────────────

  sim_add_phase "warmup"    20  1.0  pool_warmup
  sim_add_phase "analysts"  45  2.0  pool_analysts
  sim_add_phase "dashboard" 25  3.0  pool_dashboard

  sim_run "$port" "$id" "bad-mapping"
}
