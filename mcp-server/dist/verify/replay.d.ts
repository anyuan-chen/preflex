import type { QueryBenchmark } from "./types.js";
export declare function replayQueries(beforeBenchmarks: QueryBenchmark[], targetIndex: string, runs?: number): Promise<QueryBenchmark[]>;
