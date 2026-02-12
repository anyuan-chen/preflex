import type { Baseline, QueryBenchmark, VerifyResult } from "./types.js";

export function assertVerification(
  baseline: Baseline,
  afterBenchmarks: QueryBenchmark[],
  afterDocCount: number,
): VerifyResult {
  const details: string[] = [];

  // --- Correctness checks ---

  const docCountMatch = afterDocCount === baseline.doc_count;
  if (!docCountMatch) {
    details.push(`Doc count mismatch: before=${baseline.doc_count}, after=${afterDocCount}`);
  }

  // Query results: a query that failed before should now succeed, or maintain same hit count
  let allQueriesPass = true;
  const perQuery: VerifyResult["performance"]["per_query"] = [];

  for (let i = 0; i < baseline.query_benchmarks.length; i++) {
    const before = baseline.query_benchmarks[i];
    const after = afterBenchmarks[i];

    if (!after) {
      allQueriesPass = false;
      details.push(`Query "${before.label}" missing from replay results`);
      continue;
    }

    // If query failed before and succeeds now → improvement
    if (before.status !== 200 && after.status === 200) {
      perQuery.push({
        label: before.label,
        before_ms: before.took_ms,
        after_ms: after.took_ms,
        hits_match: true,
      });
      continue;
    }

    // If query succeeded before and fails now → regression
    if (before.status === 200 && after.status !== 200) {
      allQueriesPass = false;
      details.push(`Query "${before.label}" regressed: was working, now fails`);
      perQuery.push({
        label: before.label,
        before_ms: before.took_ms,
        after_ms: after.took_ms,
        hits_match: false,
      });
      continue;
    }

    // Both succeeded: check hit counts (after should be >= before)
    const hitsMatch = after.total_hits >= before.total_hits;
    if (!hitsMatch) {
      details.push(
        `Query "${before.label}" hit count decreased: ${before.total_hits} → ${after.total_hits}`,
      );
    }

    perQuery.push({
      label: before.label,
      before_ms: before.took_ms,
      after_ms: after.took_ms,
      hits_match: hitsMatch,
    });

    if (!hitsMatch) allQueriesPass = false;
  }

  // --- Performance check ---

  const validBefore = baseline.query_benchmarks.filter((q) => q.took_ms >= 0);
  const validAfter = afterBenchmarks.filter((q) => q.took_ms >= 0);

  const beforeAvg =
    validBefore.length > 0
      ? validBefore.reduce((s, q) => s + q.took_ms, 0) / validBefore.length
      : 0;
  const afterAvg =
    validAfter.length > 0
      ? validAfter.reduce((s, q) => s + q.took_ms, 0) / validAfter.length
      : 0;

  // Performance improved if: after is <= 1.1x before (10% tolerance for noise)
  // If before queries all failed (took_ms = -1), any working after is an improvement
  const improved =
    validBefore.length === 0
      ? validAfter.length > 0
      : afterAvg <= beforeAvg * 1.1;

  // --- Decision ---

  const correct = docCountMatch && allQueriesPass;
  let recommendation: VerifyResult["recommendation"];
  if (correct && improved) {
    recommendation = "auto_approve";
  } else if (correct && !improved) {
    recommendation = "hitl_review";
  } else {
    recommendation = "rollback";
  }

  return {
    passed: recommendation === "auto_approve",
    correctness: {
      doc_count_match: docCountMatch,
      mapping_correct: true, // Checked separately per operation
      sample_queries_pass: allQueriesPass,
      details,
    },
    performance: {
      improved,
      before_avg_ms: Math.round(beforeAvg * 100) / 100,
      after_avg_ms: Math.round(afterAvg * 100) / 100,
      per_query: perQuery,
    },
    recommendation,
    summary: `Correctness: ${correct ? "PASS" : "FAIL"} | Performance: ${improved ? "IMPROVED" : "DEGRADED"} (${beforeAvg.toFixed(0)}ms → ${afterAvg.toFixed(0)}ms) | → ${recommendation}`,
  };
}
