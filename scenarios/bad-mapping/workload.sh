#!/usr/bin/env bash
# bad-mapping/workload.sh — Run queries that expose mapping problems

workload_bad_mapping() {
  local port="$1" id="$2"
  local index="sb-${id}-orders"

  log "Running bad-mapping workload on $index"

  local report
  report=$(report_init "$id" "bad-mapping")

  # ── Query 1: Date range on text field ───────────────────────────────────
  # Should fail or return nonsensical results because order_date is text
  local q1
  q1=$(timed_query "$port" POST "/${index}/_search" '{
    "query": {
      "range": {
        "order_date": {
          "gte": "2026-02-11T00:00:00Z",
          "lte": "2026-02-12T23:59:59Z"
        }
      }
    },
    "size": 5
  }' "date_range_on_text_order_date")
  report=$(echo "$report" | report_add_query "$q1")

  # ── Query 2: Date histogram on text field ───────────────────────────────
  # Will fail — date_histogram requires date type
  local q2
  q2=$(timed_query "$port" POST "/${index}/_search" '{
    "size": 0,
    "aggs": {
      "over_time": {
        "date_histogram": {
          "field": "order_date",
          "calendar_interval": "hour"
        }
      }
    }
  }' "date_histogram_on_text_order_date")
  report=$(echo "$report" | report_add_query "$q2")

  # ── Query 3: Terms agg on text key_type field ──────────────────────────
  # Will fail or return analyzed tokens instead of full values
  local q3
  q3=$(timed_query "$port" POST "/${index}/_search" '{
    "size": 0,
    "aggs": {
      "by_key_type": {
        "terms": { "field": "key_type" }
      }
    }
  }' "terms_agg_on_text_key_type")
  report=$(echo "$report" | report_add_query "$q3")

  # ── Query 4: Sort by price (text) ──────────────────────────────────────
  # Lexicographic: "99.5" > "100.0"
  local q4
  q4=$(timed_query "$port" POST "/${index}/_search" '{
    "query": { "match_all": {} },
    "sort": [{ "price": "desc" }],
    "size": 5,
    "_source": ["price", "key_type"]
  }' "sort_price_text_lexicographic")
  report=$(echo "$report" | report_add_query "$q4")

  # ── Query 5: Full-text match on keyword description ─────────────────────
  # keyword means exact match only — partial match fails
  local q5
  q5=$(timed_query "$port" POST "/${index}/_search" '{
    "query": {
      "match": { "description": "rekey" }
    },
    "size": 5
  }' "fulltext_match_on_keyword_description")
  report=$(echo "$report" | report_add_query "$q5")

  # ── Query 6: Numeric range on text price ───────────────────────────────
  # Range on text does lexicographic comparison
  local q6
  q6=$(timed_query "$port" POST "/${index}/_search" '{
    "query": {
      "range": {
        "price": { "gte": 50, "lte": 200 }
      }
    },
    "size": 5
  }' "numeric_range_on_text_price")
  report=$(echo "$report" | report_add_query "$q6")

  # ── Gather diagnostics ─────────────────────────────────────────────────
  local mapping
  mapping=$(es_curl "$port" GET "/${index}/_mapping" 2>/dev/null)

  local diag
  diag=$(jq -n \
    --argjson mapping "$mapping" \
    '{ mapping: $mapping }')
  report=$(echo "$report" | report_set_diagnostics "$diag")

  # ── Finalize ────────────────────────────────────────────────────────────
  report=$(echo "$report" | report_set_summary)
  echo "$report"
}
