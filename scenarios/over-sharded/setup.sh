#!/usr/bin/env bash
# over-sharded/setup.sh — Create an index with far too many shards for its data size

setup_over_sharded() {
  local port="$1" id="$2"
  local index="sb-${id}-over-sharded-metrics"

  create_index "$port" "$index" '{
    "settings": {
      "number_of_shards": 10,
      "number_of_replicas": 0
    },
    "mappings": {
      "properties": {
        "timestamp":   { "type": "date" },
        "host":        { "type": "keyword" },
        "metric_name": { "type": "keyword" },
        "value":       { "type": "float" },
        "tags":        { "type": "keyword" }
      }
    }
  }'
}
