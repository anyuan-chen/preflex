#!/usr/bin/env bash
# over-sharded/setup.sh — Create an index with far too many shards for its data size

setup_over_sharded() {
  local port="$1" id="$2"
  local index="sb-${id}-key-inventory"

  create_index "$port" "$index" '{
    "settings": {
      "number_of_shards": 10,
      "number_of_replicas": 0
    },
    "mappings": {
      "properties": {
        "timestamp": { "type": "date" },
        "sku":       { "type": "keyword" },
        "brand":     { "type": "keyword" },
        "key_type":  { "type": "keyword" },
        "quantity":  { "type": "integer" },
        "location":  { "type": "keyword" }
      }
    }
  }'
}
