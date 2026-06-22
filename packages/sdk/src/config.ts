import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default Jetty REST API base URL (production). */
export const DEFAULT_API_URL = "https://flows-api.jetty.io";

/** Default location of the on-disk token file, per repo convention. */
export const DEFAULT_TOKEN_FILE = join(homedir(), ".config", "jetty", "token");

export interface JettyConfig {
  /**
   * API bearer token. Accepts both `mlc_*` API keys (no expiry, DB-scoped)
   * and Clerk JWTs (expiring) — the server decides; no client-side sniffing.
   *
   * Resolution order: this argument → `JETTY_API_TOKEN` env → token file.
   */
  token?: string;
  /** Base URL. Resolution order: this argument → `JETTY_API_URL` env → default. */
  apiUrl?: string;
  /** Path to a file containing the token. Default: `~/.config/jetty/token`. */
  tokenFile?: string;
}

export type TokenSource = "argument" | "env" | "file" | "none";

export interface ResolvedConfig {
  token: string | undefined;
  apiUrl: string;
  tokenSource: TokenSource;
  tokenFile: string;
}

function readTokenFile(path: string): string | undefined {
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    // Missing/unreadable file is not an error here — it's just one source.
    return undefined;
  }
}

/**
 * Resolve token + base URL from (in order) explicit args, environment, and the
 * on-disk token file. Never throws — returns `token: undefined` with
 * `tokenSource: "none"` when nothing is found, so the caller decides how to
 * surface that (the client throws a clear, source-naming error).
 */
export function resolveConfig(config: JettyConfig = {}): ResolvedConfig {
  const apiUrl = config.apiUrl || process.env.JETTY_API_URL || DEFAULT_API_URL;
  const tokenFile = config.tokenFile || DEFAULT_TOKEN_FILE;

  if (config.token) {
    return { token: config.token, apiUrl, tokenSource: "argument", tokenFile };
  }
  const envToken = process.env.JETTY_API_TOKEN;
  if (envToken) {
    return { token: envToken, apiUrl, tokenSource: "env", tokenFile };
  }
  const fileToken = readTokenFile(tokenFile);
  if (fileToken) {
    return { token: fileToken, apiUrl, tokenSource: "file", tokenFile };
  }
  return { token: undefined, apiUrl, tokenSource: "none", tokenFile };
}

/** Actionable message naming every place a token can come from. */
export function missingTokenMessage(tokenFile = DEFAULT_TOKEN_FILE): string {
  return [
    "No Jetty API token found. Provide one of the following (resolution order):",
    "  1. new JettyClient({ token: '...' })  — explicit argument",
    "  2. JETTY_API_TOKEN environment variable",
    `  3. a token file at ${tokenFile}`,
    "Get a token at https://jetty.io → Settings → API Tokens.",
  ].join("\n");
}
