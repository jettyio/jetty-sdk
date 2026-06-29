import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JettyClient,
  JettyConfigError,
  JettyRunFailedError,
  JettyTimeoutError,
  type FetchLike,
} from "../src/index.js";

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const RUN_RESPONSE = {
  message: "started",
  workflow_id: "acme-triage--abc123",
  result: {},
  trajectory: {},
  metadata: "",
};

function client(fetchImpl: FetchLike): JettyClient {
  return new JettyClient({ token: "tok", apiUrl: "http://api.test", fetch: fetchImpl });
}

describe("JettyClient construction", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.JETTY_API_TOKEN;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("throws a clear JettyConfigError when no token can be resolved", () => {
    expect(
      () => new JettyClient({ apiUrl: "http://x", tokenFile: "/nonexistent/jetty/token" }),
    ).toThrow(JettyConfigError);
  });

  it("names all three token sources in the error message", () => {
    try {
      new JettyClient({ apiUrl: "http://x", tokenFile: "/nonexistent/jetty/token" });
      expect.unreachable("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("explicit argument");
      expect(msg).toContain("JETTY_API_TOKEN");
      expect(msg).toContain("token file");
    }
  });
});

describe("runAndWait", () => {
  it("resolves with the completed trajectory", async () => {
    let polls = 0;
    const traj = await client(async (url, init) => {
      if (init?.method === "POST" && url.includes("/run/")) return json(RUN_RESPONSE);
      if (url.includes("/db/trajectory/")) {
        polls++;
        const status = polls < 2 ? "running" : "completed";
        return json({
          name: "acme/triage",
          trajectory_id: "abc123",
          status,
          error: null,
          steps: { triage: { outputs: { category: "account_access", priority: 2 } } },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }).runAndWait("acme", "triage", { ticket: {} }, { pollMs: 1, timeoutMs: 5000 });

    expect(traj.status).toBe("completed");
    expect(traj.steps.triage.outputs.category).toBe("account_access");
    expect(polls).toBe(2);
  });

  it("throws JettyRunFailedError with the server error attached", async () => {
    const promise = client(async (url, init) => {
      if (init?.method === "POST" && url.includes("/run/")) return json(RUN_RESPONSE);
      if (url.includes("/db/trajectory/"))
        return json({ status: "failed", error: "step blew up", steps: {} });
      throw new Error("unexpected");
    }).runAndWait("acme", "triage", {}, { pollMs: 1 });

    await expect(promise).rejects.toBeInstanceOf(JettyRunFailedError);
    await expect(promise).rejects.toMatchObject({ trajectoryError: "step blew up" });
  });

  it("times out when the run never reaches a terminal status", async () => {
    const promise = client(async (url, init) => {
      if (init?.method === "POST" && url.includes("/run/")) return json(RUN_RESPONSE);
      if (url.includes("/db/trajectory/")) return json({ status: "running", error: null, steps: {} });
      throw new Error("unexpected");
    }).runAndWait("acme", "triage", {}, { pollMs: 1, timeoutMs: 0 });

    await expect(promise).rejects.toBeInstanceOf(JettyTimeoutError);
  });

  it("uploads files when options.files is set", async () => {
    let body: unknown;
    const traj = await client(async (url, init) => {
      if (init?.method === "POST" && url.includes("/run/")) {
        body = init?.body;
        return json(RUN_RESPONSE);
      }
      return json({ status: "completed", error: null, steps: {} });
    }).runAndWait("acme", "triage", { vars: { x: 1 } }, {
      pollMs: 1,
      files: [{ filename: "case.json", data: '{"a":1}' }],
    });
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).getAll("files")).toHaveLength(1);
    expect(traj.status).toBe("completed");
  });

  it("calls onPoll for each poll", async () => {
    const seen: string[] = [];
    let polls = 0;
    await client(async (url, init) => {
      if (init?.method === "POST" && url.includes("/run/")) return json(RUN_RESPONSE);
      polls++;
      return json({ status: polls < 2 ? "running" : "completed", error: null, steps: {} });
    }).runAndWait("acme", "triage", {}, {
      pollMs: 1,
      onPoll: (t) => seen.push(t.status),
    });
    expect(seen).toEqual(["running", "completed"]);
  });
});

describe("multipart + labels + download", () => {
  it("runWithFiles posts init_params and files as multipart", async () => {
    let body: unknown;
    await client(async (_url, init) => {
      body = init?.body;
      return json(RUN_RESPONSE);
    }).runWithFiles("acme", "x", { foo: "bar" }, [{ filename: "a.txt", data: "hello" }]);

    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get("init_params")).toBe(JSON.stringify({ foo: "bar" }));
    expect(form.getAll("files")).toHaveLength(1);
  });

  it("addLabel posts key/value/author to the labels endpoint", async () => {
    let url = "";
    let body = "";
    await client(async (u, init) => {
      url = u;
      body = init?.body as string;
      return json({ ok: true });
    }).addLabel("acme", "triage", "abc", "review", "approved", "jon@jetty.io");

    expect(url).toContain("/trajectory/acme/triage/abc/labels");
    expect(JSON.parse(body)).toMatchObject({
      key: "review",
      value: "approved",
      author: "jon@jetty.io",
    });
  });

  it("downloadFile returns bytes and filename", async () => {
    const res = await client(
      async (url) => {
        expect(url).toContain("/api/v1/file/acme/results/out.bin");
        return new Response(new Uint8Array([9, 8, 7]), {
          status: 200,
          headers: { "content-disposition": 'attachment; filename="out.bin"' },
        });
      },
    ).downloadFile("acme/results/out.bin");

    expect(Array.from(res.bytes)).toEqual([9, 8, 7]);
    expect(res.filename).toBe("out.bin");
  });
});

describe("ingestTrajectory", () => {
  it("POSTs the eval run to the ingest endpoint and returns the result", async () => {
    let captured: { url: string; method?: string; body?: string } = { url: "" };
    const result = await client(async (url, init) => {
      captured = { url, method: init?.method, body: init?.body as string };
      return json({
        trajectory_id: "tr123",
        name: "acme/triage-grader",
        storage_path: "acme/triage-grader/0000",
        status: "completed",
        labels: [{ key: "score.accuracy", value: "0.9", created: "t", author: "eve" }],
      });
    }).ingestTrajectory("acme", "triage-grader", {
      input: { ticket: "printer down" },
      output: { category: "hardware" },
      scores: { accuracy: 0.9 },
      labels: { "eve.verdict": "passed" },
      cost_usd: 0.0093,
      source: "eve",
      trajectory_id: "tr123",
    });

    expect(captured.url).toContain("/api/v1/trajectories/acme/triage-grader/ingest");
    expect(captured.method).toBe("POST");
    const body = JSON.parse(captured.body ?? "{}");
    expect(body.scores.accuracy).toBe(0.9);
    expect(body.source).toBe("eve");
    expect(body.trajectory_id).toBe("tr123");
    expect(result.trajectory_id).toBe("tr123");
    expect(result.labels[0]?.key).toBe("score.accuracy");
  });

  it("url-encodes collection and task segments", async () => {
    let url = "";
    await client(async (u) => {
      url = u;
      return json({
        trajectory_id: "t",
        name: "a/b",
        storage_path: "a/b/0000",
        status: "completed",
        labels: [],
      });
    }).ingestTrajectory("my collection", "triage/grader", { output: "x" });

    expect(url).toContain("/trajectories/my%20collection/triage%2Fgrader/ingest");
  });
});
