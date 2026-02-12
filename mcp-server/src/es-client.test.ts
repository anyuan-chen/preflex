import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EsError } from "./es-client.js";

// We test the EsError class directly (it's a simple value class).
// Testing esFetch requires mocking global fetch + config, which we do below.

describe("EsError", () => {
  it("constructs with method, path, status, body", () => {
    const err = new EsError("GET", "/_cluster/health", 503, '{"status":"red"}');
    expect(err.method).toBe("GET");
    expect(err.path).toBe("/_cluster/health");
    expect(err.status).toBe(503);
    expect(err.body).toBe('{"status":"red"}');
    expect(err.name).toBe("EsError");
  });

  it("message includes method, path, status", () => {
    const err = new EsError("PUT", "/my-index/_settings", 400, "bad request");
    expect(err.message).toContain("PUT");
    expect(err.message).toContain("/my-index/_settings");
    expect(err.message).toContain("400");
    expect(err.message).toContain("bad request");
  });

  it("is an instance of Error", () => {
    const err = new EsError("GET", "/", 500, "fail");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("esFetch", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetModules();
  });

  it("sends correct auth header and parses JSON response", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ status: "green" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    // Dynamic import to pick up the mocked fetch
    const { esFetch } = await import("./es-client.js");
    const result = await esFetch("GET", "/_cluster/health");

    expect(capturedUrl).toContain("/_cluster/health");
    expect(capturedInit?.method).toBe("GET");
    expect(capturedInit?.headers).toHaveProperty("Authorization");
    const authHeader = (capturedInit?.headers as Record<string, string>)["Authorization"];
    expect(authHeader).toMatch(/^Basic /);
    expect(result).toEqual({ status: "green" });
  });

  it("includes Content-Type header when body is provided", async () => {
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ acknowledged: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const { esFetch } = await import("./es-client.js");
    await esFetch("PUT", "/test/_settings", { "index.number_of_replicas": 0 });

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(capturedInit?.body).toBe(JSON.stringify({ "index.number_of_replicas": 0 }));
  });

  it("does not include Content-Type when no body", async () => {
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const { esFetch } = await import("./es-client.js");
    await esFetch("GET", "/_cat/indices");

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("Content-Type");
  });

  it("throws EsError on non-ok response", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("index_not_found_exception", { status: 404 });
    }) as unknown as typeof fetch;

    const { esFetch, EsError: ImportedEsError } = await import("./es-client.js");

    await expect(esFetch("GET", "/missing/_count")).rejects.toThrow();
    try {
      await esFetch("GET", "/missing/_count");
    } catch (err) {
      expect(err).toBeInstanceOf(ImportedEsError);
      expect((err as InstanceType<typeof ImportedEsError>).status).toBe(404);
    }
  });

  it("handles empty response body", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const { esFetch } = await import("./es-client.js");
    const result = await esFetch("DELETE", "/test-index");

    expect(result).toBeUndefined();
  });
});
