#!/usr/bin/env bash
# bad-mapping/setup.sh — Create indices with deliberately wrong field types

setup_bad_mapping() {
  local port="$1" id="$2"
  local index="sb-${id}-orders"

  create_index "$port" "$index" '{
    "settings": {
      "number_of_shards": 1,
      "number_of_replicas": 0
    },
    "mappings": {
      "properties": {
        "order_date":  { "type": "text" },
        "description": { "type": "keyword" },
        "key_type":    { "type": "text" },
        "price":       { "type": "text" },
        "status":      { "type": "text" },
        "customer_id": { "type": "text" },
        "store":       { "type": "text" }
      }
    }
  }'
}
