import { esFetch } from "../es-client.js";
async function runQueryBenchmark(index, label, queryBody, runs = 3) {
    const results = [];
    for (let i = 0; i < runs; i++) {
        try {
            const resp = await esFetch("POST", `/${encodeURIComponent(index)}/_search`, {
                ...queryBody,
                size: queryBody.size ?? 10,
            });
            results.push({
                took_ms: resp.took,
                total_hits: resp.hits.total.value,
                sample_hit_ids: resp.hits.hits.map((h) => h._id).slice(0, 5),
            });
        }
        catch (err) {
            // Query might fail on bad mappings — that's expected
            return {
                label,
                query_body: queryBody,
                index,
                took_ms: -1,
                total_hits: 0,
                status: 400,
                sample_hit_ids: [],
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }
    // Take median by took_ms
    results.sort((a, b) => a.took_ms - b.took_ms);
    const median = results[Math.floor(results.length / 2)];
    return {
        label,
        query_body: queryBody,
        index,
        took_ms: median.took_ms,
        total_hits: median.total_hits,
        status: 200,
        sample_hit_ids: median.sample_hit_ids,
    };
}
export async function captureBaseline(index, operation, queries, sandboxPrefix) {
    // Gather cluster state
    const [countResp, mappingResp, settingsResp, aliasResp, healthResp, shardsResp] = await Promise.all([
        esFetch("GET", `/${encodeURIComponent(index)}/_count`),
        esFetch("GET", `/${encodeURIComponent(index)}/_mapping`),
        esFetch("GET", `/${encodeURIComponent(index)}/_settings?flat_settings=true`),
        esFetch("GET", `/${encodeURIComponent(index)}/_alias`).catch(() => ({})),
        esFetch("GET", `/_cluster/health/${encodeURIComponent(index)}`),
        esFetch("GET", `/_cat/shards/${encodeURIComponent(index)}?format=json&h=index,shard,prirep`),
    ]);
    const primaryShards = Array.isArray(shardsResp)
        ? shardsResp.filter((s) => s.prirep === "p").length
        : 0;
    // Run benchmark queries
    const benchmarks = [];
    for (const q of queries) {
        const targetIndex = `${sandboxPrefix}${q.index_suffix}`;
        if (targetIndex === index || q.index_suffix === "") {
            benchmarks.push(await runQueryBenchmark(index, q.label, q.query_body));
        }
    }
    return {
        captured_at: new Date().toISOString(),
        operation,
        target_index: index,
        doc_count: countResp.count,
        mapping: mappingResp,
        settings: settingsResp,
        aliases: aliasResp,
        health: healthResp.status,
        shard_count: primaryShards,
        query_benchmarks: benchmarks,
    };
}
//# sourceMappingURL=baseline.js.map