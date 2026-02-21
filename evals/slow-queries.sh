#!/usr/bin/env bash
# evals/slow-queries.sh — Realtime eval: expensive query patterns creep in
#
# Story: Normal application traffic, then a developer deploys code with
# wildcard searches and script scores. Then an automated report job kicks in
# with deep pagination and huge aggs. Latency climbs throughout.

eval_slow_queries() {
  local port="$1" id="$2"
  local index="sb-${id}-service-logs"

  pool_normal() {
    local queries=(
      "filter_svc|POST|/${index}/_search|{\"query\":{\"term\":{\"service_type\":\"key-cutting\"}},\"size\":10}"
      "filter_tech|POST|/${index}/_search|{\"query\":{\"term\":{\"technician\":\"tech-001\"}},\"size\":10}"
      "match_msg|POST|/${index}/_search|{\"query\":{\"match\":{\"message\":\"timeout\"}},\"size\":10}"
      "recent|POST|/${index}/_search|{\"sort\":[{\"timestamp\":\"desc\"}],\"size\":10}"
      "count_techs|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"by_tech\":{\"terms\":{\"field\":\"technician\"}}}}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  pool_bad_deploy() {
    # Mix of normal + newly deployed bad queries
    local queries=(
      # Normal (still running)
      "filter_svc|POST|/${index}/_search|{\"query\":{\"term\":{\"service_type\":\"key-cutting\"}},\"size\":10}"
      "filter_tech|POST|/${index}/_search|{\"query\":{\"term\":{\"technician\":\"tech-001\"}},\"size\":10}"
      # Bad: leading wildcards (new feature: fuzzy log search)
      "wildcard_lockout|POST|/${index}/_search|{\"query\":{\"wildcard\":{\"message\":{\"value\":\"*lockout*\"}}},\"size\":10}"
      "wildcard_rekey|POST|/${index}/_search|{\"query\":{\"wildcard\":{\"message\":{\"value\":\"*rekey*\"}}},\"size\":10}"
      # Bad: script score (new relevance ranking)
      "script_score|POST|/${index}/_search|{\"query\":{\"script_score\":{\"query\":{\"match_all\":{}},\"script\":{\"source\":\"Math.log(2 + doc['duration_ms'].value) * _score\"}}},\"size\":10}"
      # Bad: regex search
      "regex_search|POST|/${index}/_search|{\"query\":{\"regexp\":{\"message\":\".*lock.*rekey.*\"}},\"size\":10}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  pool_report_job() {
    # Bad deploy queries continue + automated report job adds deep pagination and huge aggs
    local queries=(
      # Ongoing bad queries
      "wildcard_lockout|POST|/${index}/_search|{\"query\":{\"wildcard\":{\"message\":{\"value\":\"*lockout*\"}}},\"size\":10}"
      "script_score|POST|/${index}/_search|{\"query\":{\"script_score\":{\"query\":{\"match_all\":{}},\"script\":{\"source\":\"Math.log(2 + doc['duration_ms'].value) * _score\"}}},\"size\":10}"
      # Report: deep pagination (scanning all errors)
      "deep_page_1k|POST|/${index}/_search|{\"from\":1000,\"size\":10,\"query\":{\"match_all\":{}}}"
      "deep_page_5k|POST|/${index}/_search|{\"from\":5000,\"size\":10,\"query\":{\"match_all\":{}}}"
      # Report: high cardinality agg
      "all_jobs|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"all_jobs\":{\"terms\":{\"field\":\"job_id\",\"size\":50000}}}}"
      # Report: nested agg (service_type x technician breakdown)
      "svc_tech|POST|/${index}/_search|{\"size\":0,\"aggs\":{\"by_svc\":{\"terms\":{\"field\":\"service_type\"},\"aggs\":{\"by_tech\":{\"terms\":{\"field\":\"technician\"}}}}}}"
      # Still some normal queries
      "filter_svc|POST|/${index}/_search|{\"query\":{\"term\":{\"service_type\":\"lockout\"}},\"size\":10}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  sim_add_phase "normal"     25  2.0  pool_normal
  sim_add_phase "bad_deploy" 40  3.0  pool_bad_deploy
  sim_add_phase "report_job" 25  4.0  pool_report_job

  sim_run "$port" "$id" "slow-queries"
}
