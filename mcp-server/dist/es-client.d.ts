export declare class EsError extends Error {
    readonly method: string;
    readonly path: string;
    readonly status: number;
    readonly body: string;
    constructor(method: string, path: string, status: number, body: string);
}
export declare function esFetch<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
