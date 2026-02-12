import type { VerifyQuery } from "./types.js";
/**
 * Per-scenario verification queries.
 * These are the same query patterns used in the eval bombardment scripts.
 * index_suffix is appended to the sandbox prefix (e.g. "sb-{id}-" + suffix).
 */
export declare const SCENARIO_QUERIES: Record<string, VerifyQuery[]>;
/**
 * Get verification queries for a set of scenarios.
 * Substitutes the sandbox prefix into index names.
 */
export declare function getQueriesForScenarios(scenarios: string[], sandboxPrefix: string): VerifyQuery[];
