export type VerifyMode = "auto" | "hitl" | "eval";
export interface Config {
    esUrl: string;
    esUser: string;
    esPassword: string;
    mcpPort: number;
    verifyMode: VerifyMode;
}
export declare const config: Config;
