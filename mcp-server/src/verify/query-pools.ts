import type { VerifyQuery } from "./types.js";

/**
 * Per-scenario verification queries.
 * These are the same query patterns used in the eval bombardment scripts.
 * index_suffix is appended to the sandbox prefix (e.g. "sb-{id}-" + suffix).
 */
export const SCENARIO_QUERIES: Record<string, VerifyQuery[]> = {
  "bad-mapping": [
    {
      label: "date_range_on_timestamp",
      index_suffix: "bad-mapping-logs",
      query_body: { query: { range: { timestamp: { gte: "2026-02-12" } } }, size: 5 },
      expected_behavior: "should_work",
    },
    {
      label: "date_histogram",
      index_suffix: "bad-mapping-logs",
      query_body: {
        size: 0,
        aggs: { over_time: { date_histogram: { field: "timestamp", calendar_interval: "hour" } } },
      },
      expected_behavior: "should_work",
    },
    {
      label: "terms_agg_on_service",
      index_suffix: "bad-mapping-logs",
      query_body: { size: 0, aggs: { by_service: { terms: { field: "service" } } } },
      expected_behavior: "should_work",
    },
    {
      label: "numeric_range_duration",
      index_suffix: "bad-mapping-logs",
      query_body: { query: { range: { duration_ms: { gte: 1000 } } }, size: 5 },
      expected_behavior: "should_work",
    },
    {
      label: "sort_by_duration",
      index_suffix: "bad-mapping-logs",
      query_body: { sort: [{ duration_ms: "desc" }], size: 10 },
      expected_behavior: "should_work",
    },
    {
      label: "full_text_search_message",
      index_suffix: "bad-mapping-logs",
      query_body: { query: { match: { message: "error timeout" } }, size: 10 },
      expected_behavior: "should_work",
    },
  ],

  "over-sharded": [
    {
      label: "match_all",
      index_suffix: "over-sharded-metrics",
      query_body: { query: { match_all: {} }, size: 10 },
      expected_behavior: "should_be_faster",
    },
    {
      label: "terms_agg_host",
      index_suffix: "over-sharded-metrics",
      query_body: { size: 0, aggs: { by_host: { terms: { field: "host" } } } },
      expected_behavior: "should_be_faster",
    },
    {
      label: "percentiles",
      index_suffix: "over-sharded-metrics",
      query_body: { size: 0, aggs: { pct: { percentiles: { field: "value" } } } },
      expected_behavior: "should_be_faster",
    },
    {
      label: "nested_agg",
      index_suffix: "over-sharded-metrics",
      query_body: {
        size: 0,
        aggs: {
          by_host: {
            terms: { field: "host" },
            aggs: { avg_val: { avg: { field: "value" } } },
          },
        },
      },
      expected_behavior: "should_be_faster",
    },
  ],

  "slow-queries": [
    {
      label: "basic_filter",
      index_suffix: "slow-query-logs",
      query_body: { query: { term: { level: "ERROR" } }, size: 10 },
      expected_behavior: "should_return_results",
    },
    {
      label: "service_filter",
      index_suffix: "slow-query-logs",
      query_body: { query: { term: { service: "api-gateway" } }, size: 10 },
      expected_behavior: "should_return_results",
    },
  ],

  "bad-replicas": [
    {
      label: "match_all_overreplicated",
      index_suffix: "bad-replicas-overreplicated",
      query_body: { query: { match_all: {} }, size: 10 },
      expected_behavior: "should_return_results",
    },
    {
      label: "match_all_critical",
      index_suffix: "bad-replicas-critical-noreplica",
      query_body: { query: { match_all: {} }, size: 10 },
      expected_behavior: "should_return_results",
    },
    {
      label: "terms_agg_event",
      index_suffix: "bad-replicas-overreplicated",
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
