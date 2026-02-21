#!/usr/bin/env bash
# slow-queries/setup.sh — Normal mapping but aggressively low slow-log thresholds + problematic saved queries

setup_slow_queries() {
  local port="$1" id="$2"
  local index="sb-${id}-service-logs"

  # Create index with normal mappings
  create_index "$port" "$index" '{
    "settings": {
      "number_of_shards": 1,
      "number_of_replicas": 0,
      "index.search.slowlog.threshold.query.warn": "1ms",
      "index.search.slowlog.threshold.query.info": "0ms",
      "index.search.slowlog.threshold.fetch.warn": "1ms",
      "index.search.slowlog.threshold.fetch.info": "0ms"
    },
    "mappings": {
      "properties": {
        "timestamp":    { "type": "date" },
        "message":      { "type": "text" },
        "service_type": { "type": "keyword" },
        "technician":   { "type": "keyword" },
        "job_id":       { "type": "keyword" },
        "duration_ms":  { "type": "float" }
      }
    }
  }'

  # Store some deliberately bad query templates as docs in a companion index
  local query_index="sb-${id}-service-log-queries"
  create_index "$port" "$query_index" '{
    "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
    "mappings": {
      "properties": {
        "name":        { "type": "keyword" },
        "description": { "type": "text" },
        "query_body":  { "type": "text", "index": false }
      }
    }
  }'

  # Load problematic query examples
  local queries_data=""
  queries_data+='{"index":{"_index":"'"$query_index"'"}}'$'\n'
  queries_data+='{"name":"leading_wildcard","description":"Search using leading wildcard — forces full index scan","query_body":"{\"query\":{\"wildcard\":{\"message\":{\"value\":\"*lockout*\"}}}}"}'$'\n'

  queries_data+='{"index":{"_index":"'"$query_index"'"}}'$'\n'
  queries_data+='{"name":"script_score_heavy","description":"Script score on every document — O(n) computation","query_body":"{\"query\":{\"script_score\":{\"query\":{\"match_all\":{}},\"script\":{\"source\":\"Math.log(2 + doc[\\\"duration_ms\\\"].value) * _score\"}}}}"}'$'\n'

  queries_data+='{"index":{"_index":"'"$query_index"'"}}'$'\n'
  queries_data+='{"name":"deep_pagination","description":"Deep pagination with from=10000 — scans and discards results","query_body":"{\"from\":10000,\"size\":10,\"query\":{\"match_all\":{}}}"}'$'\n'

  queries_data+='{"index":{"_index":"'"$query_index"'"}}'$'\n'
  queries_data+='{"name":"unbounded_agg","description":"High cardinality terms agg with no size limit","query_body":"{\"size\":0,\"aggs\":{\"all_jobs\":{\"terms\":{\"field\":\"job_id\",\"size\":100000}}}}"}'$'\n'

  bulk_load "$port" "$queries_data"
  refresh_index "$port" "$query_index"
}
