#!/usr/bin/env bash
# evals/bad-replicas.sh — Realtime eval: replica misconfiguration under load
#
# Story: Normal read traffic against two indices — one over-replicated (cluster
# yellow), one critical with zero replicas. Starts light, then ramps as more
# users come online. An agent should notice the yellow health and the
# unassigned shards throughout, plus the data-loss risk on the critical index.

eval_bad_replicas() {
  local port="$1" id="$2"
  local idx_over="sb-${id}-appointments"
  local idx_crit="sb-${id}-customer-billing"

  pool_trickle() {
    local queries=(
      "search_events|POST|/${idx_over}/_search|{\"query\":{\"match_all\":{}},\"size\":10}"
      "search_orders|POST|/${idx_crit}/_search|{\"query\":{\"match_all\":{}},\"size\":10}"
      "cluster_health|GET|/_cluster/health|{}"
      "count_events|POST|/${idx_over}/_count|{\"query\":{\"match_all\":{}}}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  pool_growing() {
    local queries=(
      "search_events|POST|/${idx_over}/_search|{\"query\":{\"match_all\":{}},\"size\":10}"
      "search_orders|POST|/${idx_crit}/_search|{\"query\":{\"match_all\":{}},\"size\":10}"
      "filter_event|POST|/${idx_over}/_search|{\"query\":{\"term\":{\"event\":\"appointment.booked\"}},\"size\":10}"
      "filter_status|POST|/${idx_crit}/_search|{\"query\":{\"term\":{\"status\":\"pending\"}},\"size\":10}"
      "agg_events|POST|/${idx_over}/_search|{\"size\":0,\"aggs\":{\"by_event\":{\"terms\":{\"field\":\"event\"}}}}"
      "agg_revenue|POST|/${idx_crit}/_search|{\"size\":0,\"aggs\":{\"total\":{\"sum\":{\"field\":\"amount\"}}}}"
      "cluster_health|GET|/_cluster/health|{}"
      "shard_info|GET|/_cat/shards/${idx_over}?format=json|{}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  pool_peak() {
    local queries=(
      "search_events|POST|/${idx_over}/_search|{\"query\":{\"match_all\":{}},\"size\":20}"
      "search_orders|POST|/${idx_crit}/_search|{\"query\":{\"match_all\":{}},\"size\":20}"
      "filter_event|POST|/${idx_over}/_search|{\"query\":{\"term\":{\"event\":\"walk-in\"}},\"size\":20}"
      "agg_by_customer|POST|/${idx_over}/_search|{\"size\":0,\"aggs\":{\"by_customer\":{\"terms\":{\"field\":\"customer_id\",\"size\":100}}}}"
      "agg_revenue_by_currency|POST|/${idx_crit}/_search|{\"size\":0,\"aggs\":{\"by_currency\":{\"terms\":{\"field\":\"currency\"},\"aggs\":{\"total\":{\"sum\":{\"field\":\"amount\"}}}}}}"
      "agg_by_status|POST|/${idx_crit}/_search|{\"size\":0,\"aggs\":{\"by_status\":{\"terms\":{\"field\":\"status\"}}}}"
      "date_hist_events|POST|/${idx_over}/_search|{\"size\":0,\"aggs\":{\"over_time\":{\"date_histogram\":{\"field\":\"timestamp\",\"calendar_interval\":\"hour\"}}}}"
      "cluster_health|GET|/_cluster/health|{}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  sim_add_phase "trickle" 20  0.5  pool_trickle
  sim_add_phase "growing" 40  2.0  pool_growing
  sim_add_phase "peak"    30  4.0  pool_peak

  sim_run "$port" "$id" "bad-replicas"
}
