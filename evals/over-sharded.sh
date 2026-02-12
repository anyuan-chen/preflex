#!/usr/bin/env bash
# evals/over-sharded.sh — Realtime eval: shard overhead under load
#
# Story: A metrics index with 10 shards but only 500 docs. At low QPS it's
# fine — the overhead is there but hidden. As traffic ramps, the per-shard
# fan-out cost stacks up. At peak load the coordination overhead dominates.

eval_over_sharded() {
  local port="$1" id="$2"
  local index="sb-${id}-over-sharded-metrics"

  pool_light() {
    local queries=(
      "match_all|POST|/${index}/_search|{\"query\":{\"match_all\":{}},\"size\":10}"
      "filter_host|POST|/${index}/_search|{\"query\":{\"term\":{\"host\":\"web-01\"}},\"size\":10}"
      "count|POST|/${index}/_count|{\"query\":{\"match_all\":{}}}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  pool_moderate() {
    local queries=(
      "match_all|POST|/${index}/_search|{\"query\":{\"match_all\":{}},\"size\":10}"
      "filter_host|POST|/${index}/_search|{\"query\":{\"term\":{\"host\":\"web-01\"}},\"size\":10}"
      "agg_by_host|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"by_host\":{\"terms\":{\"field\":\"host\"}}}}"
      "agg_by_metric|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"by_metric\":{\"terms\":{\"field\":\"metric_name\"}}}}"
      "date_hist|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"over_time\":{\"date_histogram\":{\"field\":\"timestamp\",\"calendar_interval\":\"hour\"}}}}"
      "multi_filter|POST|/${index}/_search|{\"query\":{\"bool\":{\"filter\":[{\"term\":{\"host\":\"db-01\"}},{\"term\":{\"metric_name\":\"cpu_usage\"}}]}},\"size\":10}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  pool_heavy() {
    # Everything at once — aggs, sorts, filters, all fanning out to 10 shards
    local queries=(
      "agg_by_host|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"by_host\":{\"terms\":{\"field\":\"host\"}}}}"
      "agg_by_metric|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"by_metric\":{\"terms\":{\"field\":\"metric_name\"}}}}"
      "date_hist|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"over_time\":{\"date_histogram\":{\"field\":\"timestamp\",\"calendar_interval\":\"minute\"}}}}"
      "multi_agg|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"by_host\":{\"terms\":{\"field\":\"host\"},\"aggs\":{\"avg_val\":{\"avg\":{\"field\":\"value\"}}}}}}"
      "sort_value|POST|/${index}/_search|{\"sort\":[{\"value\":\"desc\"}],\"size\":20}"
      "stats_agg|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"val_stats\":{\"stats\":{\"field\":\"value\"}}}}"
      "filter_agg|POST|/${index}/_search|{\"query\":{\"term\":{\"tags\":\"production\"}},\"size\":0,\"aggs\":{\"by_metric\":{\"terms\":{\"field\":\"metric_name\"}}}}"
      "percentiles|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"latency_pct\":{\"percentiles\":{\"field\":\"value\"}}}}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  sim_add_phase "light"    20  1.0  pool_light
  sim_add_phase "moderate" 40  3.0  pool_moderate
  sim_add_phase "heavy"    30  5.0  pool_heavy

  sim_run "$port" "$id" "over-sharded"
}
