export type VerifyMode = "auto" | "hitl" | "eval";

export interface Config {
  esUrl: string;
  esUser: string;
  esPassword: string;
  mcpPort: number;
  verifyMode: VerifyMode;
  kibanaUrl: string;
  agentId: string;
  monitorEnabled: boolean;
  monitorIntervalMs: number;
  slackToken: string;
  slackChannel: string;
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
  kibanaUrl: getEnv("KIBANA_URL", "http://localhost:5601"),
  agentId: getEnv("AGENT_ID", "optimizer"),
  monitorEnabled: getEnv("MONITOR_ENABLED", "true") === "true",
  monitorIntervalMs: parseInt(getEnv("MONITOR_INTERVAL_MS", "10000"), 10),
  slackToken: getEnv("SLACK_TOKEN", ""),
  slackChannel: getEnv("SLACK_CHANNEL", ""),
};
