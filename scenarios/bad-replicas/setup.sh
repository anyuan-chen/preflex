#!/usr/bin/env bash
# bad-replicas/setup.sh — Indices with misconfigured replica counts

setup_bad_replicas() {
  local port="$1" id="$2"

  # Index 1: replicas=3 on a single-node cluster → all replica shards unassigned → yellow health
  local index1="sb-${id}-appointments"
  create_index "$port" "$index1" '{
    "settings": {
      "number_of_shards": 1,
      "number_of_replicas": 3
    },
    "mappings": {
      "properties": {
        "timestamp":   { "type": "date" },
        "event":       { "type": "keyword" },
        "customer_id": { "type": "keyword" },
        "details":     { "type": "text" }
      }
    }
  }'

  # Index 2: replicas=0 for supposedly critical data → no redundancy
  local index2="sb-${id}-customer-billing"
  create_index "$port" "$index2" '{
    "settings": {
      "number_of_shards": 1,
      "number_of_replicas": 0
    },
    "mappings": {
      "properties": {
        "timestamp":  { "type": "date" },
        "invoice_id": { "type": "keyword" },
        "customer":   { "type": "keyword" },
        "amount":     { "type": "float" },
        "currency":   { "type": "keyword" },
        "status":     { "type": "keyword" }
      }
    }
  }'
}
