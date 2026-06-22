/**
 * Typed error hierarchy for the Jetty SDK.
 *
 * Every error thrown by the SDK extends {@link JettyError}, so callers can
 * `catch (e) { if (e instanceof JettyError) ... }` and narrow from there.
 *
 * The load-bearing distinction is {@link JettyInProgressError}: long *sync*
 * runs return a Cloudflare 524 after ~100s while the workflow keeps executing
 * server-side. Retrying that HTTP call is wrong — the caller should poll the
 * trajectory instead. We surface 524 as its own type and never auto-retry it.
 */
export class JettyError extends Error {
  constructor(message: string) {
    super(message);
    // Restore prototype chain so `instanceof` works after transpilation.
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Configuration/auth could not be resolved (e.g. no token found). */
export class JettyConfigError extends JettyError {}

/** A non-2xx HTTP response that isn't covered by a more specific subtype. */
export class JettyApiError extends JettyError {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `Jetty API error ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

/** 401 / 403 — token missing, expired, or not scoped to the resource. */
export class JettyAuthError extends JettyApiError {
  constructor(status: number, body: string) {
    super(
      status,
      body,
      `Jetty authentication failed (${status}): token rejected. ` +
        "Check your token in .env (JETTY_API_TOKEN) or ~/.config/jetty/token. " +
        `Server said: ${body || "(no body)"}`,
    );
  }
}

/** 404 — collection, task, or trajectory does not exist. */
export class JettyNotFoundError extends JettyApiError {
  constructor(status: number, body: string) {
    super(status, body, `Jetty resource not found (404): ${body || "(no body)"}`);
  }
}

/** 5xx (except 524) — a transient server error; retried with backoff. */
export class JettyServerError extends JettyApiError {}

/** A network-level failure (DNS, connection reset, fetch threw). Retryable. */
export class JettyNetworkError extends JettyError {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(`Jetty network error: ${message}`);
    this.cause = cause;
  }
}

/** The request exceeded the client-side timeout (AbortController). */
export class JettyTimeoutError extends JettyError {}

/**
 * Cloudflare 524 — the edge gave up after ~100s, but the run is almost
 * certainly still executing server-side. Switch to polling the trajectory;
 * never retry the original call.
 */
export class JettyInProgressError extends JettyError {
  constructor(
    message = "Request timed out at the edge (Cloudflare 524) but the run is likely " +
      "still executing — poll the trajectory instead of retrying.",
  ) {
    super(message);
  }
}

/** A run reached a terminal non-success status (failed/cancelled/archived). */
export class JettyRunFailedError extends JettyError {
  readonly status: string;
  readonly trajectoryError?: string;
  readonly trajectoryId?: string;
  constructor(status: string, trajectoryError?: string, trajectoryId?: string) {
    super(
      `Jetty run ended with status "${status}"` +
        (trajectoryError ? `: ${trajectoryError}` : "") +
        (trajectoryId ? ` (trajectory ${trajectoryId})` : ""),
    );
    this.status = status;
    this.trajectoryError = trajectoryError;
    this.trajectoryId = trajectoryId;
  }
}
