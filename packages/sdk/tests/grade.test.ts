import { describe, expect, it } from "vitest";
import { JettyClient, JettyError, gradeWithJetty, type FetchLike } from "../src/index.js";

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const RUN_RESPONSE = {
  message: "started",
  workflow_id: "acme-triage-grader--abc123",
  result: {},
  trajectory: {},
  metadata: "",
};

/** A completed grading trajectory whose `run` step emitted a grade.json file. */
function completedWithGrade(grade: unknown, key = "acme/results/grade.json") {
  return {
    name: "acme/triage-grader",
    trajectory_id: "abc123",
    status: "completed",
    error: null,
    steps: { run: { outputs: { files: [key] } } },
    __grade: grade, // stashed so the fake fetch can serve it on download
  };
}

function client(fetchImpl: FetchLike): JettyClient {
  return new JettyClient({ token: "tok", apiUrl: "http://api.test", fetch: fetchImpl });
}

describe("gradeWithJetty", () => {
  it("runs the grader, reads the grade file, and labels the trajectory", async () => {
    const labelBodies: Array<Record<string, unknown>> = [];
    const grade = { total: 4.5, pass: true };

    const result = await gradeWithJetty<{ total: number; pass: boolean }>(
      client(async (url, init) => {
        if (init?.method === "POST" && url.includes("/run/")) return json(RUN_RESPONSE);
        if (url.includes("/db/trajectory/")) return json(completedWithGrade(grade));
        if (url.includes("/api/v1/file/")) return json(grade); // download grade.json
        if (url.includes("/labels")) {
          labelBodies.push(JSON.parse(init?.body as string));
          return json({ ok: true });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
      "acme",
      "triage-grader",
      {
        files: [{ filename: "case.json", data: '{"ticket":1}' }],
        pollMs: 1,
        labels: (g) => ({ "eval.grade": g.total.toFixed(2), "eval.pass": String(g.pass) }),
      },
    );

    expect(result.grade).toEqual(grade);
    expect(result.trajectoryId).toBe("abc123");
    expect(result.gradeKey).toBe("acme/results/grade.json");
    // labels reflect the parsed grade and went to the right trajectory
    expect(labelBodies).toEqual([
      { key: "eval.grade", value: "4.50", author: "jetty-sdk" },
      { key: "eval.pass", value: "true", author: "jetty-sdk" },
    ]);
  });

  it("throws a clear JettyError when no grade file is produced", async () => {
    const promise = gradeWithJetty(
      client(async (url, init) => {
        if (init?.method === "POST" && url.includes("/run/")) return json(RUN_RESPONSE);
        if (url.includes("/db/trajectory/"))
          return json({ status: "completed", error: null, steps: { run: { outputs: { files: [] } } } });
        throw new Error(`unexpected request: ${url}`);
      }),
      "acme",
      "triage-grader",
      { files: [{ filename: "case.json", data: "{}" }], pollMs: 1 },
    );

    await expect(promise).rejects.toBeInstanceOf(JettyError);
    await expect(promise).rejects.toThrow(/no grade file/);
  });

  it("honors a custom gradeFile matcher and parseGrade", async () => {
    const result = await gradeWithJetty<number>(
      client(async (url, init) => {
        if (init?.method === "POST" && url.includes("/run/")) return json(RUN_RESPONSE);
        if (url.includes("/db/trajectory/"))
          return json({
            status: "completed",
            error: null,
            trajectory_id: "abc123",
            steps: { run: { outputs: { files: ["acme/results/score.txt"] } } },
          });
        if (url.includes("/api/v1/file/"))
          return new Response("4.2", { status: 200 });
        throw new Error(`unexpected request: ${url}`);
      }),
      "acme",
      "triage-grader",
      {
        files: [{ filename: "case.json", data: "{}" }],
        pollMs: 1,
        gradeFile: (k) => k.endsWith("score.txt"),
        parseGrade: (bytes) => Number(new TextDecoder().decode(bytes)),
      },
    );

    expect(result.grade).toBe(4.2);
    expect(result.gradeKey).toBe("acme/results/score.txt");
  });
});
