function getEnv(key, fallback) {
    return process.env[key] ?? fallback;
}
export const config = {
    esUrl: getEnv("ES_URL", "http://localhost:9210"),
    esUser: getEnv("ES_USER", "elastic"),
    esPassword: getEnv("ES_PASSWORD", "changeme"),
    mcpPort: parseInt(getEnv("MCP_PORT", "3100"), 10),
    verifyMode: getEnv("VERIFY_MODE", "auto"),
};
//# sourceMappingURL=config.js.map