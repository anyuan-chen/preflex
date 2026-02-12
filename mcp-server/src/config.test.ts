import { describe, it, expect, vi, afterEach } from "vitest";

describe("config", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("uses defaults when no env vars are set", async () => {
    // Clear relevant env vars
    const saved: Record<string, string | undefined> = {};
    for (const key of ["ES_URL", "ES_USER", "ES_PASSWORD", "MCP_PORT", "VERIFY_MODE"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }

    try {
      const { config } = await import("./config.js");
      expect(config.esUrl).toBe("http://localhost:9210");
      expect(config.esUser).toBe("elastic");
      expect(config.esPassword).toBe("changeme");
      expect(config.mcpPort).toBe(3100);
      expect(config.verifyMode).toBe("auto");
    } finally {
      // Restore
      for (const [key, val] of Object.entries(saved)) {
        if (val !== undefined) process.env[key] = val;
      }
    }
  });

  it("reads from environment variables", async () => {
    process.env.ES_URL = "http://custom:9200";
    process.env.ES_USER = "admin";
    process.env.ES_PASSWORD = "secret";
    process.env.MCP_PORT = "4000";
    process.env.VERIFY_MODE = "hitl";

    try {
      const { config } = await import("./config.js");
      expect(config.esUrl).toBe("http://custom:9200");
      expect(config.esUser).toBe("admin");
      expect(config.esPassword).toBe("secret");
      expect(config.mcpPort).toBe(4000);
      expect(config.verifyMode).toBe("hitl");
    } finally {
      delete process.env.ES_URL;
      delete process.env.ES_USER;
      delete process.env.ES_PASSWORD;
      delete process.env.MCP_PORT;
      delete process.env.VERIFY_MODE;
    }
  });
});
