#!/usr/bin/env bash
# evals/over-sharded.sh — Realtime eval: shard overhead under load
#
# Story: A key-inventory index with 10 shards but only 500 docs. At low QPS it's
# fine — the overhead is there but hidden. As traffic ramps, the per-shard
# fan-out cost stacks up. At peak load the coordination overhead dominates.

eval_over_sharded() {
  local port="$1" id="$2"
  local index="sb-${id}-key-inventory"

  pool_light() {
    local queries=(
      "match_all|POST|/${index}/_search|{\"query\":{\"match_all\":{}},\"size\":10}"
      "filter_brand|POST|/${index}/_search|{\"query\":{\"term\":{\"brand\":\"Schlage\"}},\"size\":10}"
      "count|POST|/${index}/_count|{\"query\":{\"match_all\":{}}}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  pool_moderate() {
    local queries=(
      "match_all|POST|/${index}/_search|{\"query\":{\"match_all\":{}},\"size\":10}"
      "filter_brand|POST|/${index}/_search|{\"query\":{\"term\":{\"brand\":\"Schlage\"}},\"size\":10}"
      "agg_by_brand|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"by_brand\":{\"terms\":{\"field\":\"brand\"}}}}"
      "agg_by_key_type|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"by_key_type\":{\"terms\":{\"field\":\"key_type\"}}}}"
      "date_hist|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"over_time\":{\"date_histogram\":{\"field\":\"timestamp\",\"calendar_interval\":\"hour\"}}}}"
      "multi_filter|POST|/${index}/_search|{\"query\":{\"bool\":{\"filter\":[{\"term\":{\"brand\":\"Kwikset\"}},{\"term\":{\"key_type\":\"deadbolt\"}}]}},\"size\":10}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  pool_heavy() {
    # Everything at once — aggs, sorts, filters, all fanning out to 10 shards
    local queries=(
      "agg_by_brand|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"by_brand\":{\"terms\":{\"field\":\"brand\"}}}}"
      "agg_by_key_type|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"by_key_type\":{\"terms\":{\"field\":\"key_type\"}}}}"
      "date_hist|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"over_time\":{\"date_histogram\":{\"field\":\"timestamp\",\"calendar_interval\":\"minute\"}}}}"
      "multi_agg|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"by_brand\":{\"terms\":{\"field\":\"brand\"},\"aggs\":{\"avg_val\":{\"avg\":{\"field\":\"quantity\"}}}}}}"
      "sort_quantity|POST|/${index}/_search|{\"sort\":[{\"quantity\":\"desc\"}],\"size\":20}"
      "stats_agg|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"val_stats\":{\"stats\":{\"field\":\"quantity\"}}}}"
      "filter_agg|POST|/${index}/_search|{\"query\":{\"term\":{\"location\":\"main-shop\"}},\"size\":0,\"aggs\":{\"by_key_type\":{\"terms\":{\"field\":\"key_type\"}}}}"
      "percentiles|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"latency_pct\":{\"percentiles\":{\"field\":\"quantity\"}}}}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  sim_add_phase "light"    20  1.0  pool_light
  sim_add_phase "moderate" 40  3.0  pool_moderate
  sim_add_phase "heavy"    30  5.0  pool_heavy

  sim_run "$port" "$id" "over-sharded"
}
