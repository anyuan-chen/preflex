export interface QueryBenchmark {
    label: string;
    query_body: Record<string, unknown>;
    index: string;
    took_ms: number;
    total_hits: number;
    status: number;
    sample_hit_ids: string[];
    error?: string;
}
export interface Baseline {
    captured_at: string;
    operation: "reindex" | "shrink" | "update_settings" | "manage_aliases";
    target_index: string;
    doc_count: number;
    mapping: Record<string, unknown>;
    settings: Record<string, unknown>;
    aliases: Record<string, unknown>;
    health: string;
    shard_count: number;
    query_benchmarks: QueryBenchmark[];
}
export interface VerifyResult {
    passed: boolean;
    correctness: {
        doc_count_match: boolean;
        mapping_correct: boolean;
        sample_queries_pass: boolean;
        details: string[];
    };
    performance: {
        improved: boolean;
        before_avg_ms: number;
        after_avg_ms: number;
        per_query: Array<{
            label: string;
            before_ms: number;
            after_ms: number;
            hits_match: boolean;
        }>;
    };
    recommendation: "auto_approve" | "hitl_review" | "rollback";
    summary: string;
}
export interface VerifyQuery {
    label: string;
    index_suffix: string;
    query_body: Record<string, unknown>;
    expected_behavior: "should_work" | "should_be_faster" | "should_return_results";
}
