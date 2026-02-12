export type VerifyMode = "auto" | "hitl" | "eval";

export interface Config {
  esUrl: string;
  esUser: string;
  esPassword: string;
  mcpPort: number;
  verifyMode: VerifyMode;
}

function getEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config: Config = {
  esUrl: getEnv("ES_URL", "http://localhost:9210"),
  esUser: getEnv("ES_USER", "elastic"),
  esPassword: getEnv("ES_PASSWORD", "changeme"),
  mcpPort: parseInt(getEnv("MCP_PORT", "3100"), 10),
  verifyMode: (getEnv("VERIFY_MODE", "auto") as VerifyMode),
};
