import { config } from "./config.js";
export class EsError extends Error {
    method;
    path;
    status;
    body;
    constructor(method, path, status, body) {
        super(`ES ${method} ${path} → ${status}: ${body}`);
        this.method = method;
        this.path = path;
        this.status = status;
        this.body = body;
        this.name = "EsError";
    }
}
export async function esFetch(method, path, body) {
    const url = `${config.esUrl}${path}`;
    const headers = {
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
    if (!text)
        return undefined;
    return JSON.parse(text);
}
//# sourceMappingURL=es-client.js.map