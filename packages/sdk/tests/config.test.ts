import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_API_URL, resolveConfig } from "../src/index.js";

describe("resolveConfig", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.JETTY_API_TOKEN;
    delete process.env.JETTY_API_URL;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("prefers an explicit token argument over env", () => {
    process.env.JETTY_API_TOKEN = "env-token";
    const r = resolveConfig({ token: "arg-token" });
    expect(r.token).toBe("arg-token");
    expect(r.tokenSource).toBe("argument");
  });

  it("falls back to the JETTY_API_TOKEN env var", () => {
    process.env.JETTY_API_TOKEN = "env-token";
    const r = resolveConfig();
    expect(r.token).toBe("env-token");
    expect(r.tokenSource).toBe("env");
  });

  it("falls back to the on-disk token file (trimmed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "jetty-"));
    const file = join(dir, "token");
    writeFileSync(file, "  file-token\n");
    try {
      const r = resolveConfig({ tokenFile: file });
      expect(r.token).toBe("file-token");
      expect(r.tokenSource).toBe("file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports tokenSource 'none' when nothing is set", () => {
    const r = resolveConfig({ tokenFile: "/nonexistent/jetty/token/path" });
    expect(r.token).toBeUndefined();
    expect(r.tokenSource).toBe("none");
  });

  it("defaults the api url to production", () => {
    expect(resolveConfig({ token: "x" }).apiUrl).toBe(DEFAULT_API_URL);
  });

  it("resolves api url from arg → env → default", () => {
    process.env.JETTY_API_URL = "http://env-url";
    expect(resolveConfig({ token: "x" }).apiUrl).toBe("http://env-url");
    expect(resolveConfig({ token: "x", apiUrl: "http://arg-url" }).apiUrl).toBe("http://arg-url");
  });
});
