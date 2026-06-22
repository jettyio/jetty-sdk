import {
  JettyApiError,
  JettyAuthError,
  JettyInProgressError,
  JettyNetworkError,
  JettyNotFoundError,
  JettyServerError,
  JettyTimeoutError,
} from "./errors.js";

/** Minimal fetch signature so a custom/mock implementation can be injected. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  apiUrl: string;
  /** Returns a bearer token or throws a clear, source-naming error. */
  getToken: () => string;
  /** Per-request timeout in ms (AbortController). Default 60_000. */
  timeoutMs?: number;
  /** Max retries on retryable failures (network + 5xx, never 524). Default 2. */
  maxRetries?: number;
  /** Base backoff in ms; doubles each attempt. Default 500. */
  retryBaseMs?: number;
  /** Injectable fetch (defaults to global fetch). */
  fetch?: FetchLike;
  /** Injectable sleep (defaults to setTimeout); handy for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions extends RequestInit {
  /**
   * Override retry behaviour. Defaults to true for GET/HEAD and false for
   * mutations (POST/PUT/PATCH/DELETE), since those aren't idempotent and a
   * blind retry could double-run a workflow.
   */
  retry?: boolean;
}

/** Raw bytes plus the bits of response metadata callers usually want. */
export interface BytesResponse {
  bytes: Uint8Array;
  contentType?: string;
  filename?: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isAbortError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    (e as { name?: string }).name === "AbortError"
  );
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Map a non-2xx status to the most specific typed error. */
export function mapHttpError(status: number, body: string): JettyApiError | JettyInProgressError {
  if (status === 401 || status === 403) return new JettyAuthError(status, body);
  if (status === 404) return new JettyNotFoundError(status, body);
  // 524: edge timeout. The run is likely still going — surface, never retry.
  if (status === 524) return new JettyInProgressError();
  if (status >= 500) return new JettyServerError(status, body);
  return new JettyApiError(status, body);
}

function isRetryable(e: unknown): boolean {
  // Transient server errors and network blips are safe to retry. Auth (4xx),
  // not-found, edge-524, and client timeouts are not.
  return e instanceof JettyServerError || e instanceof JettyNetworkError;
}

function filenameFromDisposition(cd: string | null): string | undefined {
  if (!cd) return undefined;
  // RFC 5987 `filename*=UTF-8''name` or plain `filename="name"`.
  const star = /filename\*=(?:UTF-8'')?["']?([^"';]+)["']?/i.exec(cd);
  if (star?.[1]) return decodeURIComponent(star[1]);
  const plain = /filename=["']?([^"';]+)["']?/i.exec(cd);
  return plain?.[1];
}

/**
 * Thin HTTP layer over `fetch`: bearer auth, per-request timeout, typed error
 * mapping, and exponential-backoff retries for transient failures.
 */
export class HttpClient {
  private readonly apiUrl: string;
  private readonly getToken: () => string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: HttpClientOptions) {
    this.apiUrl = options.apiUrl;
    this.getToken = options.getToken;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) {
      throw new Error(
        "No fetch implementation available. Use Node 18+ or pass `fetch` in JettyClientOptions.",
      );
    }
    this.fetchImpl = f;
    this.sleep = options.sleep ?? defaultSleep;
  }

  private authHeaders(extra?: RequestInit["headers"]): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.getToken()}` };
    if (extra) {
      new Headers(extra).forEach((value, key) => {
        headers[key] = value;
      });
    }
    return headers;
  }

  /** Run one attempt; resolves with the raw Response or throws a typed error. */
  private async attemptRaw(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (e) {
      if (isAbortError(e)) {
        throw new JettyTimeoutError(`Request to ${url} timed out after ${this.timeoutMs}ms`);
      }
      throw new JettyNetworkError(e instanceof Error ? e.message : String(e), e);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Retry wrapper around {@link attemptRaw}, returning the ok Response. */
  private async fetchOk(url: string, init: RequestInit, retry: boolean): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.attemptRaw(url, init);
        if (res.ok) return res;
        throw mapHttpError(res.status, await safeText(res));
      } catch (e) {
        const canRetry = retry && attempt < this.maxRetries && isRetryable(e);
        if (!canRetry) throw e;
        await this.sleep(this.retryBaseMs * 2 ** attempt);
      }
    }
  }

  private defaultRetry(method: string | undefined): boolean {
    const m = (method ?? "GET").toUpperCase();
    return m === "GET" || m === "HEAD";
  }

  /** JSON/text request. Parses by content-type. */
  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const { retry, ...init } = options;
    const url = `${this.apiUrl}${path}`;
    const shouldRetry = retry ?? this.defaultRetry(init.method);
    const res = await this.fetchOk(
      url,
      { ...init, headers: this.authHeaders(init.headers) },
      shouldRetry,
    );
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return (await res.json()) as T;
    }
    return (await res.text()) as unknown as T;
  }

  /** Binary request — used for file downloads. Honors Content-Disposition. */
  async requestBytes(path: string, options: RequestOptions = {}): Promise<BytesResponse> {
    const { retry, ...init } = options;
    const url = `${this.apiUrl}${path}`;
    const shouldRetry = retry ?? this.defaultRetry(init.method);
    const res = await this.fetchOk(
      url,
      { ...init, headers: this.authHeaders(init.headers) },
      shouldRetry,
    );
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      bytes: buf,
      contentType: res.headers.get("content-type") ?? undefined,
      filename: filenameFromDisposition(res.headers.get("content-disposition")),
    };
  }
}
