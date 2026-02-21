#!/usr/bin/env bash
# evals/clees-keys.sh — Realtime eval: Clees Keys app anti-patterns
#
# Story: A locksmith SaaS app migrated from Postgres to Elasticsearch.
#   Phase 1 (normal):         CRUD traffic — match_all, term filters, sorts. Baseline green.
#   Phase 2 (search_deploy):  Search feature ships with wildcard + script_score (PRs #4–#7).
#                              Latency climbs, slow log fills up.
#   Phase 3 (analytics_deploy): Analytics dashboard ships with broken aggs on text fields
#                              (PRs #8–#9). Critical errors, agent investigates.

eval_clees_keys() {
  local port="$1" id="$2"
  local customers="sb-${id}-customers"
  local orders="sb-${id}-orders"
  local logs="sb-${id}-service-logs"
  local appointments="sb-${id}-appointments"

  # ── Phase 1: Normal app traffic ─────────────────────────────────────────

  pool_normal() {
    local queries=(
      "match_all_cust|POST|/${customers}/_search|{\"query\":{\"match_all\":{}},\"size\":10}"
      "match_all_orders|POST|/${orders}/_search|{\"query\":{\"match_all\":{}},\"size\":10}"
      "term_svc_type|POST|/${logs}/_search|{\"query\":{\"term\":{\"service_type\":\"key-cutting\"}},\"size\":10}"
      "term_tech|POST|/${logs}/_search|{\"query\":{\"term\":{\"technician\":\"tech-001\"}},\"size\":10}"
      "recent_logs|POST|/${logs}/_search|{\"sort\":[{\"timestamp\":\"desc\"}],\"size\":10}"
      "count_orders|POST|/${orders}/_count|{\"query\":{\"match_all\":{}}}"
      "count_customers|POST|/${customers}/_count|{\"query\":{\"match_all\":{}}}"
      "term_appt_status|POST|/${appointments}/_search|{\"query\":{\"term\":{\"status\":\"scheduled\"}},\"size\":10}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  # ── Phase 2: Search feature deployed (PRs #4–#7) ───────────────────────

  pool_search_deploy() {
    local queries=(
      # PR #4: ILIKE '%john%' → wildcard on customer name
      "wildcard_name|POST|/${customers}/_search|{\"query\":{\"wildcard\":{\"name\":{\"value\":\"*john*\"}}},\"size\":10}"
      "wildcard_name2|POST|/${customers}/_search|{\"query\":{\"wildcard\":{\"name\":{\"value\":\"*alice*\"}}},\"size\":10}"
      "wildcard_email|POST|/${customers}/_search|{\"query\":{\"wildcard\":{\"email\":{\"value\":\"*smith*\"}}},\"size\":10}"
      # PR #5: ILIKE 'dead%' → wildcard on order description
      "wildcard_desc|POST|/${orders}/_search|{\"query\":{\"wildcard\":{\"description\":{\"value\":\"dead*\"}}},\"size\":10}"
      "wildcard_desc2|POST|/${orders}/_search|{\"query\":{\"wildcard\":{\"description\":{\"value\":\"*key*\"}}},\"size\":10}"
      # PR #6: similarity(address, $1) → script_score on appointments
      "script_addr|POST|/${appointments}/_search|{\"query\":{\"script_score\":{\"query\":{\"match_all\":{}},\"script\":{\"source\":\"def target = '123 Main St'; def addr = doc['address.keyword'].size() > 0 ? doc['address.keyword'].value : ''; return addr.length() > 0 ? (1.0 / (1.0 + Math.abs(addr.length() - target.length()))) : 0;\"}}},\"size\":5}"
      # PR #7: LIKE '%lockout%' AND timestamp >= $1 → wildcard + range
      "wildcard_log|POST|/${logs}/_search|{\"query\":{\"bool\":{\"must\":[{\"wildcard\":{\"message\":{\"value\":\"*lockout*\"}}},{\"range\":{\"timestamp\":{\"gte\":\"now-24h\"}}}]}},\"size\":10}"
      "wildcard_log2|POST|/${logs}/_search|{\"query\":{\"wildcard\":{\"message\":{\"value\":\"*rekey*\"}}},\"size\":10}"
      # Normal traffic continues
      "match_all_cust|POST|/${customers}/_search|{\"query\":{\"match_all\":{}},\"size\":10}"
      "term_svc_type|POST|/${logs}/_search|{\"query\":{\"term\":{\"service_type\":\"lockout\"}},\"size\":10}"
      "recent_logs|POST|/${logs}/_search|{\"sort\":[{\"timestamp\":\"desc\"}],\"size\":10}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  # ── Phase 3: Analytics dashboard deployed (PRs #8–#9) ──────────────────

  pool_analytics_deploy() {
    local queries=(
      # PR #8: GROUP BY tech, svc, DATE_TRUNC('week') → nested aggs on logs
      "agg_tech_svc|POST|/${logs}/_search|{\"size\":0,\"aggs\":{\"by_tech\":{\"terms\":{\"field\":\"technician\"},\"aggs\":{\"by_svc\":{\"terms\":{\"field\":\"service_type\"},\"aggs\":{\"over_time\":{\"date_histogram\":{\"field\":\"timestamp\",\"calendar_interval\":\"week\"}}}}}}}}"
      # PR #9: GROUP BY DATE_TRUNC('week', order_date) → date_histogram on TEXT field (breaks)
      "date_hist_orders|POST|/${orders}/_search|{\"size\":0,\"aggs\":{\"orders_over_time\":{\"date_histogram\":{\"field\":\"order_date\",\"calendar_interval\":\"week\"}}}}"
      # PR #9: GROUP BY store, key_type + SUM(price) → terms agg on TEXT fields (breaks)
      "agg_store_ktype|POST|/${orders}/_search|{\"size\":0,\"aggs\":{\"by_store\":{\"terms\":{\"field\":\"store\"},\"aggs\":{\"by_key_type\":{\"terms\":{\"field\":\"key_type\"},\"aggs\":{\"total_revenue\":{\"sum\":{\"field\":\"price\"}}}}}}}}"
      # Deep pagination — analytics paging
      "deep_page|POST|/${orders}/_search|{\"from\":1000,\"size\":10,\"query\":{\"match_all\":{}}}"
      # Unbounded agg — export all job IDs
      "all_jobs|POST|/${logs}/_search|{\"size\":0,\"aggs\":{\"all_jobs\":{\"terms\":{\"field\":\"job_id\",\"size\":50000}}}}"
      # Phase 2 queries continue (compounding load)
      "wildcard_name|POST|/${customers}/_search|{\"query\":{\"wildcard\":{\"name\":{\"value\":\"*john*\"}}},\"size\":10}"
      "wildcard_desc|POST|/${orders}/_search|{\"query\":{\"wildcard\":{\"description\":{\"value\":\"dead*\"}}},\"size\":10}"
      "script_addr|POST|/${appointments}/_search|{\"query\":{\"script_score\":{\"query\":{\"match_all\":{}},\"script\":{\"source\":\"def target = '123 Main St'; def addr = doc['address.keyword'].size() > 0 ? doc['address.keyword'].value : ''; return addr.length() > 0 ? (1.0 / (1.0 + Math.abs(addr.length() - target.length()))) : 0;\"}}},\"size\":5}"
      "wildcard_log|POST|/${logs}/_search|{\"query\":{\"bool\":{\"must\":[{\"wildcard\":{\"message\":{\"value\":\"*lockout*\"}}},{\"range\":{\"timestamp\":{\"gte\":\"now-24h\"}}}]}},\"size\":10}"
      # Normal traffic still present
      "term_tech|POST|/${logs}/_search|{\"query\":{\"term\":{\"technician\":\"tech-002\"}},\"size\":10}"
    )
    echo "${queries[$((RANDOM % ${#queries[@]}))]}"
  }

  # ── Phase definitions ───────────────────────────────────────────────────

  sim_add_phase "normal"           25  2.0  pool_normal
  sim_add_phase "search_deploy"    40  3.5  pool_search_deploy
  sim_add_phase "analytics_deploy" 30  5.0  pool_analytics_deploy

  sim_run "$port" "$id" "clees-keys"
}
