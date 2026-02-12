import { esFetch } from "../es-client.js";
import type { QueryBenchmark } from "./types.js";

export async function replayQueries(
  beforeBenchmarks: QueryBenchmark[],
  targetIndex: string,
  runs = 3,
): Promise<QueryBenchmark[]> {
  const results: QueryBenchmark[] = [];

  for (const q of beforeBenchmarks) {
    const attempts: Array<{ took_ms: number; total_hits: number; sample_hit_ids: string[] }> = [];

    for (let i = 0; i < runs; i++) {
      try {
        const resp = await esFetch<{
          took: number;
          hits: {
            total: { value: number };
            hits: Array<{ _id: string }>;
          };
        }>("POST", `/${encodeURIComponent(targetIndex)}/_search`, {
          ...q.query_body,
          size: (q.query_body.size as number) ?? 10,
        });

        attempts.push({
          took_ms: resp.took,
          total_hits: resp.hits.total.value,
          sample_hit_ids: resp.hits.hits.map((h) => h._id).slice(0, 5),
        });
      } catch (err) {
        // If the query now works when it didn't before, that's an improvement
        // If it still fails, record the error
        results.push({
          label: q.label,
          query_body: q.query_body,
          index: targetIndex,
          took_ms: -1,
          total_hits: 0,
          status: 400,
          sample_hit_ids: [],
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }

    if (attempts.length > 0) {
      // Take median
      attempts.sort((a, b) => a.took_ms - b.took_ms);
      const median = attempts[Math.floor(attempts.length / 2)];

      results.push({
        label: q.label,
        query_body: q.query_body,
        index: targetIndex,
        took_ms: median.took_ms,
        total_hits: median.total_hits,
        status: 200,
        sample_hit_ids: median.sample_hit_ids,
      });
    }
  }

  return results;
}
