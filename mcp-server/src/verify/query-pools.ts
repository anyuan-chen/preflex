import type { VerifyQuery } from "./types.js";

/**
 * Per-scenario verification queries.
 * These are the same query patterns used in the eval bombardment scripts.
 * index_suffix is appended to the sandbox prefix (e.g. "sb-{id}-" + suffix).
 */
export const SCENARIO_QUERIES: Record<string, VerifyQuery[]> = {
  "bad-mapping": [
    {
      label: "date_range_on_order_date",
      index_suffix: "orders",
      query_body: { query: { range: { order_date: { gte: "2026-02-12" } } }, size: 5 },
      expected_behavior: "should_work",
    },
    {
      label: "date_histogram",
      index_suffix: "orders",
      query_body: {
        size: 0,
        aggs: { over_time: { date_histogram: { field: "order_date", calendar_interval: "hour" } } },
      },
      expected_behavior: "should_work",
    },
    {
      label: "terms_agg_on_key_type",
      index_suffix: "orders",
      query_body: { size: 0, aggs: { by_key_type: { terms: { field: "key_type" } } } },
      expected_behavior: "should_work",
    },
    {
      label: "numeric_range_price",
      index_suffix: "orders",
      query_body: { query: { range: { price: { gte: 50 } } }, size: 5 },
      expected_behavior: "should_work",
    },
    {
      label: "sort_by_price",
      index_suffix: "orders",
      query_body: { sort: [{ price: "desc" }], size: 10 },
      expected_behavior: "should_work",
    },
    {
      label: "full_text_search_description",
      index_suffix: "orders",
      query_body: { query: { match: { description: "deadbolt rekey" } }, size: 10 },
      expected_behavior: "should_work",
    },
  ],

  "over-sharded": [
    {
      label: "match_all",
      index_suffix: "key-inventory",
      query_body: { query: { match_all: {} }, size: 10 },
      expected_behavior: "should_be_faster",
    },
    {
      label: "terms_agg_brand",
      index_suffix: "key-inventory",
      query_body: { size: 0, aggs: { by_brand: { terms: { field: "brand" } } } },
      expected_behavior: "should_be_faster",
    },
    {
      label: "percentiles",
      index_suffix: "key-inventory",
      query_body: { size: 0, aggs: { pct: { percentiles: { field: "quantity" } } } },
      expected_behavior: "should_be_faster",
    },
    {
      label: "nested_agg",
      index_suffix: "key-inventory",
      query_body: {
        size: 0,
        aggs: {
          by_brand: {
            terms: { field: "brand" },
            aggs: { avg_qty: { avg: { field: "quantity" } } },
          },
        },
      },
      expected_behavior: "should_be_faster",
    },
  ],

  "slow-queries": [
    {
      label: "basic_filter",
      index_suffix: "service-logs",
      query_body: { query: { term: { service_type: "lockout" } }, size: 10 },
      expected_behavior: "should_return_results",
    },
    {
      label: "technician_filter",
      index_suffix: "service-logs",
      query_body: { query: { term: { technician: "tech-001" } }, size: 10 },
      expected_behavior: "should_return_results",
    },
  ],

  "bad-replicas": [
    {
      label: "match_all_appointments",
      index_suffix: "appointments",
      query_body: { query: { match_all: {} }, size: 10 },
      expected_behavior: "should_return_results",
    },
    {
      label: "match_all_billing",
      index_suffix: "customer-billing",
      query_body: { query: { match_all: {} }, size: 10 },
      expected_behavior: "should_return_results",
    },
    {
      label: "terms_agg_event",
      index_suffix: "appointments",
      query_body: { size: 0, aggs: { by_event: { terms: { field: "event" } } } },
      expected_behavior: "should_return_results",
    },
  ],
};

/**
 * Get verification queries for a set of scenarios.
 * Substitutes the sandbox prefix into index names.
 */
export function getQueriesForScenarios(
  scenarios: string[],
  sandboxPrefix: string,
): VerifyQuery[] {
  const queries: VerifyQuery[] = [];
  for (const scenario of scenarios) {
    const pool = SCENARIO_QUERIES[scenario];
    if (pool) {
      queries.push(...pool);
    }
  }
  return queries;
}
