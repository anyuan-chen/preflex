#!/usr/bin/env bash
# slow-queries/workload.sh — Execute the problematic query patterns and measure impact

workload_slow_queries() {
  local port="$1" id="$2"
  local index="sb-${id}-slow-query-logs"

  log "Running slow-queries workload on $index"

  local report
  report=$(report_init "$id" "slow-queries")

  # ── Query 1: Leading wildcard ──────────────────────────────────────────
  local q1
  q1=$(timed_query "$port" POST "/${index}/_search" '{
    "query": {
      "wildcard": {
        "message": { "value": "*timeout*" }
      }
    },
    "size": 5
  }' "leading_wildcard")
  report=$(echo "$report" | report_add_query "$q1")

  # ── Query 2: Script score on all docs ──────────────────────────────────
  local q2
  q2=$(timed_query "$port" POST "/${index}/_search" '{
    "query": {
      "script_score": {
        "query": { "match_all": {} },
        "script": {
          "source": "Math.log(2 + doc[\"duration_ms\"].value) * _score"
        }
      }
    },
    "size": 5
  }' "script_score_all_docs")
  report=$(echo "$report" | report_add_query "$q2")

  # ── Query 3: Deep pagination ───────────────────────────────────────────
  local q3
  q3=$(timed_query "$port" POST "/${index}/_search" '{
    "from": 10000,
    "size": 10,
    "query": { "match_all": {} }
  }' "deep_pagination_from_10000")
  report=$(echo "$report" | report_add_query "$q3")

  # ── Query 4: High-cardinality terms agg ────────────────────────────────
  local q4
  q4=$(timed_query "$port" POST "/${index}/_search" '{
    "size": 0,
    "aggs": {
      "all_traces": {
        "terms": {
          "field": "trace_id",
          "size": 100000
        }
      }
    }
  }' "unbounded_high_cardinality_agg")
  report=$(echo "$report" | report_add_query "$q4")

  # ── Query 5: Normal query for baseline ─────────────────────────────────
  local q5
  q5=$(timed_query "$port" POST "/${index}/_search" '{
    "query": {
      "bool": {
        "filter": [
          { "term": { "service": "api-gateway" } },
          { "term": { "level": "ERROR" } }
        ]
      }
    },
    "size": 10
  }' "baseline_filtered_query")
  report=$(echo "$report" | report_add_query "$q5")

  # ── Query 6: Regex query ───────────────────────────────────────────────
  local q6
  q6=$(timed_query "$port" POST "/${index}/_search" '{
    "query": {
      "regexp": {
        "message": ".*fail.*auth.*"
      }
    },
    "size": 5
  }' "regex_query")
  report=$(echo "$report" | report_add_query "$q6")

  # ── Gather diagnostics ─────────────────────────────────────────────────
  local settings
  settings=$(es_curl "$port" GET "/${index}/_settings" 2>/dev/null)

  local slowlog_thresholds
  slowlog_thresholds=$(echo "$settings" | jq '
    to_entries[0].value.settings.index.search.slowlog // {}')

  # Check the slow log by looking at index stats (search count)
  local search_stats
  search_stats=$(es_curl "$port" GET "/${index}/_stats/search" 2>/dev/null)

  local diag
  diag=$(jq -n \
    --argjson slowlog "$slowlog_thresholds" \
    --argjson search_stats "$search_stats" \
    '{
      slowlog_thresholds: $slowlog,
      search_stats: ($search_stats | .indices | to_entries[0].value.primaries.search // {}),
      problematic_patterns: [
        "Leading wildcard: *timeout* — cannot use inverted index",
        "Script score on match_all — executes on every document",
        "Deep pagination from=10000 — fetches and discards 10k results",
        "High-cardinality terms agg size=100000 on trace_id — massive memory use",
        "Regex with .* prefix — equivalent to leading wildcard"
      ]
    }')
  report=$(echo "$report" | report_set_diagnostics "$diag")

  # ── Finalize ────────────────────────────────────────────────────────────
  report=$(echo "$report" | report_set_summary)
  echo "$report"
}
