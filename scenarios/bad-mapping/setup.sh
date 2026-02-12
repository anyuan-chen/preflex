#!/usr/bin/env bash
# bad-mapping/setup.sh — Create indices with deliberately wrong field types

setup_bad_mapping() {
  local port="$1" id="$2"
  local index="sb-${id}-bad-mapping-logs"

  create_index "$port" "$index" '{
    "settings": {
      "number_of_shards": 1,
      "number_of_replicas": 0
    },
    "mappings": {
      "properties": {
        "timestamp":   { "type": "text" },
        "message":     { "type": "keyword" },
        "service":     { "type": "text" },
        "duration_ms": { "type": "text" },
        "status_code": { "type": "text" },
        "user_id":     { "type": "text" },
        "path":        { "type": "text" }
      }
    }
  }'
}
