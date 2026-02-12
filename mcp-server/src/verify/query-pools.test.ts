import { describe, it, expect } from "vitest";
import { SCENARIO_QUERIES, getQueriesForScenarios } from "./query-pools.js";

describe("SCENARIO_QUERIES", () => {
  it("has entries for all four scenarios", () => {
    expect(SCENARIO_QUERIES).toHaveProperty("bad-mapping");
    expect(SCENARIO_QUERIES).toHaveProperty("over-sharded");
    expect(SCENARIO_QUERIES).toHaveProperty("slow-queries");
    expect(SCENARIO_QUERIES).toHaveProperty("bad-replicas");
  });

  it("bad-mapping has 6 queries", () => {
    expect(SCENARIO_QUERIES["bad-mapping"]).toHaveLength(6);
  });

  it("over-sharded has 4 queries", () => {
    expect(SCENARIO_QUERIES["over-sharded"]).toHaveLength(4);
  });

  it("slow-queries has 2 queries", () => {
    expect(SCENARIO_QUERIES["slow-queries"]).toHaveLength(2);
  });

  it("bad-replicas has 3 queries", () => {
    expect(SCENARIO_QUERIES["bad-replicas"]).toHaveLength(3);
  });

  it("each query has required fields", () => {
    for (const [scenario, queries] of Object.entries(SCENARIO_QUERIES)) {
      for (const q of queries) {
        expect(q, `${scenario}/${q.label}`).toHaveProperty("label");
        expect(q, `${scenario}/${q.label}`).toHaveProperty("index_suffix");
        expect(q, `${scenario}/${q.label}`).toHaveProperty("query_body");
        expect(q, `${scenario}/${q.label}`).toHaveProperty("expected_behavior");
        expect(typeof q.label).toBe("string");
        expect(typeof q.index_suffix).toBe("string");
        expect(typeof q.query_body).toBe("object");
        expect(["should_work", "should_be_faster", "should_return_results"]).toContain(
          q.expected_behavior,
        );
      }
    }
  });

  it("all labels are unique within a scenario", () => {
    for (const [scenario, queries] of Object.entries(SCENARIO_QUERIES)) {
      const labels = queries.map((q) => q.label);
      const unique = new Set(labels);
      expect(unique.size, `duplicate labels in ${scenario}`).toBe(labels.length);
    }
  });
});

describe("getQueriesForScenarios", () => {
  it("returns queries for a single scenario", () => {
    const queries = getQueriesForScenarios(["bad-mapping"], "sb-abc1-");
    expect(queries.length).toBe(6);
  });

  it("returns combined queries for multiple scenarios", () => {
    const queries = getQueriesForScenarios(
      ["bad-mapping", "over-sharded"],
      "sb-abc1-",
    );
    expect(queries.length).toBe(10); // 6 + 4
  });

  it("returns empty array for unknown scenario", () => {
    const queries = getQueriesForScenarios(["nonexistent"], "sb-abc1-");
    expect(queries).toEqual([]);
  });

  it("ignores unknown scenarios mixed with known ones", () => {
    const queries = getQueriesForScenarios(
      ["bad-mapping", "nonexistent"],
      "sb-abc1-",
    );
    expect(queries.length).toBe(6);
  });

  it("returns all queries when all scenarios requested", () => {
    const queries = getQueriesForScenarios(
      ["bad-mapping", "over-sharded", "slow-queries", "bad-replicas"],
      "sb-test-",
    );
    expect(queries.length).toBe(15); // 6 + 4 + 2 + 3
  });
});
