import { config } from "./config.js";

export class EsError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`ES ${method} ${path} → ${status}: ${body}`);
    this.name = "EsError";
  }
}

export async function esFetch<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${config.esUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${config.esUser}:${config.esPassword}`).toString("base64")}`,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const resp = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new EsError(method, path, resp.status, text);
  }

  const text = await resp.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
