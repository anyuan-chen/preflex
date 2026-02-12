import { describe, it, expect } from "vitest";
import { assertVerification } from "./assert.js";
import type { Baseline, QueryBenchmark } from "./types.js";

function makeBaseline(overrides: Partial<Baseline> = {}): Baseline {
  return {
    captured_at: "2026-01-01T00:00:00Z",
    operation: "reindex",
    target_index: "test-index",
    doc_count: 1000,
    mapping: {},
    settings: {},
    aliases: {},
    health: "green",
    shard_count: 1,
    query_benchmarks: [],
    ...overrides,
  };
}

function makeBenchmark(overrides: Partial<QueryBenchmark> = {}): QueryBenchmark {
  return {
    label: "test_query",
    query_body: { query: { match_all: {} } },
    index: "test-index",
    took_ms: 10,
    total_hits: 100,
    status: 200,
    sample_hit_ids: ["1", "2", "3"],
    ...overrides,
  };
}

describe("assertVerification", () => {
  describe("decision matrix", () => {
    it("auto_approve when correct + improved", () => {
      const baseline = makeBaseline({
        doc_count: 100,
        query_benchmarks: [makeBenchmark({ took_ms: 50, total_hits: 10 })],
      });
      const after = [makeBenchmark({ took_ms: 30, total_hits: 10 })];

      const result = assertVerification(baseline, after, 100);

      expect(result.recommendation).toBe("auto_approve");
      expect(result.passed).toBe(true);
      expect(result.correctness.doc_count_match).toBe(true);
      expect(result.correctness.sample_queries_pass).toBe(true);
      expect(result.performance.improved).toBe(true);
    });

    it("auto_approve when correct + same performance (within 10% tolerance)", () => {
      const baseline = makeBaseline({
        doc_count: 100,
        query_benchmarks: [makeBenchmark({ took_ms: 50, total_hits: 10 })],
      });
      // 55ms is within 1.1x of 50ms
      const after = [makeBenchmark({ took_ms: 55, total_hits: 10 })];

      const result = assertVerification(baseline, after, 100);

      expect(result.recommendation).toBe("auto_approve");
      expect(result.performance.improved).toBe(true);
    });

    it("hitl_review when correct but performance degraded", () => {
      const baseline = makeBaseline({
        doc_count: 100,
        query_benchmarks: [makeBenchmark({ took_ms: 50, total_hits: 10 })],
      });
      // 60ms exceeds 1.1x of 50ms (55ms threshold)
      const after = [makeBenchmark({ took_ms: 60, total_hits: 10 })];

      const result = assertVerification(baseline, after, 100);

      expect(result.recommendation).toBe("hitl_review");
      expect(result.passed).toBe(false);
      expect(result.correctness.doc_count_match).toBe(true);
      expect(result.performance.improved).toBe(false);
    });

    it("rollback when doc count mismatch", () => {
      const baseline = makeBaseline({
        doc_count: 100,
        query_benchmarks: [makeBenchmark({ took_ms: 50, total_hits: 10 })],
      });
      const after = [makeBenchmark({ took_ms: 30, total_hits: 10 })];

      const result = assertVerification(baseline, after, 90);

      expect(result.recommendation).toBe("rollback");
      expect(result.passed).toBe(false);
      expect(result.correctness.doc_count_match).toBe(false);
    });

    it("rollback when query regresses (was working, now fails)", () => {
      const baseline = makeBaseline({
        doc_count: 100,
        query_benchmarks: [makeBenchmark({ status: 200, took_ms: 50, total_hits: 10 })],
      });
      const after = [makeBenchmark({ status: 400, took_ms: -1, total_hits: 0 })];

      const result = assertVerification(baseline, after, 100);

      expect(result.recommendation).toBe("rollback");
      expect(result.correctness.sample_queries_pass).toBe(false);
    });
  });

  describe("query improvement detection", () => {
    it("query that failed before but works now is an improvement", () => {
      const baseline = makeBaseline({
        doc_count: 100,
        query_benchmarks: [makeBenchmark({ status: 400, took_ms: -1, total_hits: 0 })],
      });
      const after = [makeBenchmark({ status: 200, took_ms: 20, total_hits: 50 })];

      const result = assertVerification(baseline, after, 100);

      expect(result.recommendation).toBe("auto_approve");
      expect(result.performance.improved).toBe(true);
    });

    it("hit count decrease is a failure", () => {
      const baseline = makeBaseline({
        doc_count: 100,
        query_benchmarks: [makeBenchmark({ total_hits: 50 })],
      });
      const after = [makeBenchmark({ total_hits: 30 })];

      const result = assertVerification(baseline, after, 100);

      expect(result.correctness.sample_queries_pass).toBe(false);
      expect(result.correctness.details.some((d) => d.includes("hit count decreased"))).toBe(true);
    });

    it("hit count increase is acceptable", () => {
      const baseline = makeBaseline({
        doc_count: 100,
        query_benchmarks: [makeBenchmark({ total_hits: 50, took_ms: 10 })],
      });
      const after = [makeBenchmark({ total_hits: 60, took_ms: 10 })];

      const result = assertVerification(baseline, after, 100);

      expect(result.correctness.sample_queries_pass).toBe(true);
    });

    it("missing replay query is a failure", () => {
      const baseline = makeBaseline({
        doc_count: 100,
        query_benchmarks: [
          makeBenchmark({ label: "q1" }),
          makeBenchmark({ label: "q2" }),
        ],
      });
      // Only one result returned
      const after = [makeBenchmark({ label: "q1" })];

      const result = assertVerification(baseline, after, 100);

      expect(result.correctness.sample_queries_pass).toBe(false);
      expect(result.correctness.details.some((d) => d.includes("missing from replay"))).toBe(true);
    });
  });

  describe("performance calculation", () => {
    it("computes average from multiple queries", () => {
      const baseline = makeBaseline({
        doc_count: 100,
        query_benchmarks: [
          makeBenchmark({ label: "q1", took_ms: 20, total_hits: 10 }),
          makeBenchmark({ label: "q2", took_ms: 40, total_hits: 10 }),
        ],
      });
      const after = [
        makeBenchmark({ label: "q1", took_ms: 15, total_hits: 10 }),
        makeBenchmark({ label: "q2", took_ms: 25, total_hits: 10 }),
      ];

      const result = assertVerification(baseline, after, 100);

      expect(result.performance.before_avg_ms).toBe(30);
      expect(result.performance.after_avg_ms).toBe(20);
      expect(result.performance.improved).toBe(true);
    });

    it("handles empty benchmarks gracefully", () => {
      const baseline = makeBaseline({ doc_count: 100, query_benchmarks: [] });
      const result = assertVerification(baseline, [], 100);

      // No queries to compare = can't confirm improvement → hitl_review
      expect(result.recommendation).toBe("hitl_review");
      expect(result.performance.before_avg_ms).toBe(0);
      expect(result.performance.after_avg_ms).toBe(0);
      expect(result.performance.improved).toBe(false);
      // But correctness is fine
      expect(result.correctness.doc_count_match).toBe(true);
      expect(result.correctness.sample_queries_pass).toBe(true);
    });

    it("all-failed before + working after = improved", () => {
      const baseline = makeBaseline({
        doc_count: 100,
        query_benchmarks: [
          makeBenchmark({ label: "q1", status: 400, took_ms: -1 }),
        ],
      });
      const after = [
        makeBenchmark({ label: "q1", status: 200, took_ms: 10 }),
      ];

      const result = assertVerification(baseline, after, 100);

      expect(result.performance.improved).toBe(true);
    });
  });

  describe("summary string", () => {
    it("includes correctness, performance, and recommendation", () => {
      const baseline = makeBaseline({
        doc_count: 100,
        query_benchmarks: [makeBenchmark({ took_ms: 50, total_hits: 10 })],
      });
      const after = [makeBenchmark({ took_ms: 30, total_hits: 10 })];

      const result = assertVerification(baseline, after, 100);

      expect(result.summary).toContain("PASS");
      expect(result.summary).toContain("IMPROVED");
      expect(result.summary).toContain("auto_approve");
    });
  });

  describe("per_query details", () => {
    it("records before/after ms and hit match for each query", () => {
      const baseline = makeBaseline({
        doc_count: 100,
        query_benchmarks: [
          makeBenchmark({ label: "fast", took_ms: 5, total_hits: 10 }),
          makeBenchmark({ label: "slow", took_ms: 100, total_hits: 20 }),
        ],
      });
      const after = [
        makeBenchmark({ label: "fast", took_ms: 3, total_hits: 10 }),
        makeBenchmark({ label: "slow", took_ms: 80, total_hits: 20 }),
      ];

      const result = assertVerification(baseline, after, 100);

      expect(result.performance.per_query).toHaveLength(2);
      expect(result.performance.per_query[0]).toEqual({
        label: "fast",
        before_ms: 5,
        after_ms: 3,
        hits_match: true,
      });
      expect(result.performance.per_query[1]).toEqual({
        label: "slow",
        before_ms: 100,
        after_ms: 80,
        hits_match: true,
      });
    });
  });
});
