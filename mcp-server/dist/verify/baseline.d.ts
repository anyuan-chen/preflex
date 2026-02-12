import type { Baseline, VerifyQuery } from "./types.js";
export declare function captureBaseline(index: string, operation: Baseline["operation"], queries: VerifyQuery[], sandboxPrefix: string): Promise<Baseline>;
