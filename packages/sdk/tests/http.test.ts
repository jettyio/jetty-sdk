import { describe, expect, it } from "vitest";
import {
  HttpClient,
  JettyAuthError,
  JettyInProgressError,
  JettyNotFoundError,
  JettyServerError,
  JettyTimeoutError,
  type FetchLike,
} from "../src/index.js";

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

function makeClient(fetchImpl: FetchLike, overrides: Record<string, unknown> = {}): HttpClient {
  return new HttpClient({
    apiUrl: "http://api.test",
    getToken: () => "tok",
    retryBaseMs: 1,
    sleep: async () => {},
    fetch: fetchImpl,
    ...overrides,
  });
}

describe("HttpClient", () => {
  it("parses JSON and sends a bearer token", async () => {
    let seenAuth: string | undefined;
    const client = makeClient(async (_url, init) => {
      seenAuth = (init?.headers as Record<string, string>)?.Authorization;
      return json({ a: 1 });
    });
    const res = await client.request<{ a: number }>("/x");
    expect(res).toEqual({ a: 1 });
    expect(seenAuth).toBe("Bearer tok");
  });

  it("maps a Cloudflare 524 to JettyInProgressError and never retries it", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls++;
      return text("edge timeout", 524);
    });
    await expect(client.request("/slow")).rejects.toBeInstanceOf(JettyInProgressError);
    expect(calls).toBe(1);
  });

  it("retries transient 5xx with backoff, then succeeds", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls++;
      return calls < 2 ? text("try later", 503) : json({ ok: true });
    });
    const res = await client.request<{ ok: boolean }>("/x");
    expect(res).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("gives up after maxRetries on persistent 5xx", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls++;
      return text("down", 503);
    });
    await expect(client.request("/x")).rejects.toBeInstanceOf(JettyServerError);
    expect(calls).toBe(3); // 1 + 2 retries (default maxRetries=2)
  });

  it("does not retry 4xx", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls++;
      return text("nope", 404);
    });
    await expect(client.request("/x")).rejects.toBeInstanceOf(JettyNotFoundError);
    expect(calls).toBe(1);
  });

  it("maps 401/403 to JettyAuthError", async () => {
    const c1 = makeClient(async () => text("bad token", 401));
    const c2 = makeClient(async () => text("forbidden", 403));
    await expect(c1.request("/x")).rejects.toBeInstanceOf(JettyAuthError);
    await expect(c2.request("/x")).rejects.toBeInstanceOf(JettyAuthError);
  });

  it("retries network errors on GET", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls++;
      if (calls < 2) throw new TypeError("fetch failed");
      return json({ ok: true });
    });
    const res = await client.request<{ ok: boolean }>("/x");
    expect(res).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("does not retry non-idempotent mutations by default", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls++;
      return text("down", 503);
    });
    await expect(client.request("/x", { method: "POST" })).rejects.toBeInstanceOf(JettyServerError);
    expect(calls).toBe(1);
  });

  it("retries a mutation when retry:true is forced", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls++;
      return calls < 2 ? text("down", 503) : json({ ok: true });
    });
    const res = await client.request<{ ok: boolean }>("/x", { method: "POST", retry: true });
    expect(res).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("surfaces a client-side timeout as JettyTimeoutError", async () => {
    const client = makeClient(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
      { timeoutMs: 5 },
    );
    await expect(client.request("/hang")).rejects.toBeInstanceOf(JettyTimeoutError);
  });

  it("downloads bytes and reads the filename from Content-Disposition", async () => {
    const client = makeClient(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="out.bin"',
          },
        }),
    );
    const res = await client.requestBytes("/api/v1/file/acme/out.bin");
    expect(Array.from(res.bytes)).toEqual([1, 2, 3]);
    expect(res.filename).toBe("out.bin");
    expect(res.contentType).toBe("application/octet-stream");
  });
});
