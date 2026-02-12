#!/usr/bin/env bash
# evals/mixed-degradation.sh — Realtime eval: multiple problems compound
#
# Story: A cluster with all four problems. Traffic starts normal across all
# indices. Then usage patterns shift — analysts query the bad-mapping index,
# load increases on the over-sharded index, someone deploys wildcard queries,
# and the replica situation stays yellow the whole time. This is the "real
# production" eval — everything happening at once, getting worse together.
#
# Requires: sandbox created with ALL scenarios.

eval_mixed_degradation() {
  local port="$1" id="$2"
  local idx_map="sb-${id}-bad-mapping-logs"
  local idx_shard="sb-${id}-over-sharded-metrics"
  local idx_slow="sb-${id}-slow-query-logs"
  local idx_over="sb-${id}-bad-replicas-overreplicated"
  local idx_crit="sb-${id}-bad-replicas-critical-noreplica"

  pool_calm() {
    # Light, broad traffic. Things mostly work.
    local queries=(
      "map_match_all|POST|/${idx_map}/_search|{\"query\":{\"match_all\":{}},\"size\":5}"
      "shard_match_all|POST|/${idx_shard}/_search|{\"query\":{\"match_all\":{}},\"size\":5}"
      "slow_filter|POST|/${idx_slow}/_search|{\"query\":{\"term\":{\"level\":\"ERROR\"}},\"size\":5}"
      "rep_events|POST|/${idx_over}/_search|{\"query\":{\"match_all\":{}},\"size\":5}"
      "rep_orders|POST|/${idx_crit}/_search|{\"query\":{\"match_all\":{}},\"size\":5}"
      "health|GET|/_cluster/health|{}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  pool_shifting() {
    # Analysts start dashboarding on bad-mapping. Load increases on over-sharded.
    # Wildcards appear on slow-queries. Cluster still yellow from replicas.
    local queries=(
      # Bad mapping: dashboard queries that break
      "map_date_hist|POST|/${idx_map}/_search|{\"size\":0,\"aggs\":{\"over_time\":{\"date_histogram\":{\"field\":\"timestamp\",\"calendar_interval\":\"hour\"}}}}"
      "map_agg_svc|POST|/${idx_map}/_search|{\"size\":0,\"aggs\":{\"by_service\":{\"terms\":{\"field\":\"service\"}}}}"
      "map_sort_dur|POST|/${idx_map}/_search|{\"sort\":[{\"duration_ms\":\"desc\"}],\"size\":10}"
      # Over-sharded: heavier aggs
      "shard_agg_host|POST|/${idx_shard}/_search|{\"size\":0,\"aggs\":{\"by_host\":{\"terms\":{\"field\":\"host\"}}}}"
      "shard_agg_metric|POST|/${idx_shard}/_search|{\"size\":0,\"aggs\":{\"by_metric\":{\"terms\":{\"field\":\"metric_name\"}}}}"
      # Slow queries: wildcards appearing
      "slow_wildcard|POST|/${idx_slow}/_search|{\"query\":{\"wildcard\":{\"message\":{\"value\":\"*timeout*\"}}},\"size\":10}"
      "slow_normal|POST|/${idx_slow}/_search|{\"query\":{\"term\":{\"service\":\"api-gateway\"}},\"size\":10}"
      # Replicas: steady traffic, cluster yellow
      "rep_events|POST|/${idx_over}/_search|{\"query\":{\"term\":{\"event\":\"user.login\"}},\"size\":10}"
      "rep_orders|POST|/${idx_crit}/_search|{\"query\":{\"term\":{\"status\":\"pending\"}},\"size\":10}"
      "health|GET|/_cluster/health|{}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  pool_compounding() {
    # Everything is bad now. All problem patterns firing simultaneously.
    local queries=(
      # Bad mapping: all broken query types
      "map_date_range|POST|/${idx_map}/_search|{\"query\":{\"range\":{\"timestamp\":{\"gte\":\"2026-02-12\"}}},\"size\":5}"
      "map_agg_svc|POST|/${idx_map}/_search|{\"size\":0,\"aggs\":{\"by_service\":{\"terms\":{\"field\":\"service\"}}}}"
      "map_num_range|POST|/${idx_map}/_search|{\"query\":{\"range\":{\"duration_ms\":{\"gte\":1000}}},\"size\":5}"
      "map_date_hist|POST|/${idx_map}/_search|{\"size\":0,\"aggs\":{\"over_time\":{\"date_histogram\":{\"field\":\"timestamp\",\"calendar_interval\":\"minute\"}}}}"
      # Over-sharded: heavy nested aggs
      "shard_nested|POST|/${idx_shard}/_search|{\"size\":0,\"aggs\":{\"by_host\":{\"terms\":{\"field\":\"host\"},\"aggs\":{\"avg_val\":{\"avg\":{\"field\":\"value\"}}}}}}"
      "shard_pct|POST|/${idx_shard}/_search|{\"size\":0,\"aggs\":{\"pct\":{\"percentiles\":{\"field\":\"value\"}}}}"
      # Slow queries: script score + deep pagination + huge agg
      "slow_script|POST|/${idx_slow}/_search|{\"query\":{\"script_score\":{\"query\":{\"match_all\":{}},\"script\":{\"source\":\"Math.log(2 + doc['duration_ms'].value) * _score\"}}},\"size\":5}"
      "slow_deep|POST|/${idx_slow}/_search|{\"from\":5000,\"size\":10,\"query\":{\"match_all\":{}}}"
      "slow_huge_agg|POST|/${idx_slow}/_search|{\"size\":0,\"aggs\":{\"all_traces\":{\"terms\":{\"field\":\"trace_id\",\"size\":50000}}}}"
      "slow_wildcard|POST|/${idx_slow}/_search|{\"query\":{\"wildcard\":{\"message\":{\"value\":\"*fail*\"}}},\"size\":10}"
      # Replicas: high load on both
      "rep_agg_events|POST|/${idx_over}/_search|{\"size\":0,\"aggs\":{\"by_event\":{\"terms\":{\"field\":\"event\"}}}}"
      "rep_agg_revenue|POST|/${idx_crit}/_search|{\"size\":0,\"aggs\":{\"by_currency\":{\"terms\":{\"field\":\"currency\"},\"aggs\":{\"total\":{\"sum\":{\"field\":\"amount\"}}}}}}"
      "health|GET|/_cluster/health|{}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  sim_add_phase "calm"        25  1.5  pool_calm
  sim_add_phase "shifting"    45  3.0  pool_shifting
  sim_add_phase "compounding" 30  5.0  pool_compounding

  sim_run "$port" "$id" "mixed-degradation"
}
