# @jetty/sdk

Typed TypeScript client for the [Jetty](https://jetty.io) AI/ML workflow
platform. Run a task, poll a **trajectory** to completion, read step
inputs/outputs, and attach labels — all fully typed, from your own code.

```ts
import { JettyClient } from "@jetty/sdk";

const jetty = new JettyClient();            // token from env or ~/.config/jetty/token
const run = await jetty.runAndWait("acme", "triage", { ticket });
const { category, priority, draft_reply } = run.steps.triage.outputs;
```

- **Zero deps.** Native `fetch`, ESM, Node 18+.
- **Typed end-to-end.** `Trajectory`, `Step`, `Label`, `WorkflowResponse` mirror the backend models.
- **Hardened HTTP.** Per-request timeouts, exponential-backoff retries, and a typed error hierarchy.
- **Knows the sharp edges.** Handles the `workflow_id` → `trajectoryId` split and the Cloudflare-524 "still running" case for you.

---

## Install

```bash
npm install @jetty/sdk
```

## Authentication

The client resolves a bearer token from, in order:

1. an explicit argument — `new JettyClient({ token: "mlc_…" })`
2. the `JETTY_API_TOKEN` environment variable
3. a token file at `~/.config/jetty/token`

Both `mlc_*` API keys (no expiry, scoped per collection) and Clerk JWTs are
accepted — the server decides, no client-side sniffing. The base URL resolves
from `apiUrl` arg → `JETTY_API_URL` → `https://flows-api.jetty.io`.

If no token can be found, the constructor throws a `JettyConfigError` that names
all three sources. Get a token at **jetty.io → Settings → API Tokens**.

```ts
// Explicit config
const jetty = new JettyClient({
  token: process.env.MY_TOKEN,
  apiUrl: "https://flows-api.jetty.io",
  timeoutMs: 60_000,   // per-request timeout (default 60s)
  maxRetries: 2,       // retries on network errors + 5xx, never 524 (default 2)
});
```

## Quickstart

```ts
import { JettyClient } from "@jetty/sdk";

const jetty = new JettyClient();

// 1. Run a task and wait for the trajectory to finish.
const run = await jetty.runAndWait("acme", "triage", {
  ticket: { subject: "Reset email never arrives", body: "...", tier: "pro" },
});

// 2. Read typed step outputs.
const triage = run.steps.triage.outputs;        // Record<string, unknown>
console.log(run.status);                          // "completed"

// 3. Record a human-in-the-loop decision as a label.
await jetty.addLabel("acme", "triage", run.trajectory_id, "review", "approved", "you@acme.com");
```

## Core concepts

- **Collection** — a namespace that owns tasks, environment vars, and trial keys.
- **Task** — a server-side **runbook** (workflow-as-JSON) you can run.
- **Trajectory** — one execution: every step's inputs/outputs, status, and labels. The unit everything else builds on.
- **Label** — a `{ key, value, author }` annotation on a trajectory (reviews, eval scores, …).

> Today `task` must be a Jetty runbook (server-side execution). "Bring your own
> function" (client-side eval) lands in a later project of the SDK initiative.

## Running tasks

```ts
// Async: returns immediately with a workflow_id you can poll.
const started = await jetty.runWorkflow("acme", "triage", { ticket });
// started.workflow_id === "acme-triage--a1b2c3d4"

// Run + poll to completion (recommended). Throws on failed/cancelled/timeout.
const run = await jetty.runAndWait("acme", "triage", { ticket }, {
  pollMs: 2000,            // poll interval (default 2s)
  timeoutMs: 1_800_000,    // overall budget (default 30m)
  onPoll: (t) => console.log(t.status),
  useTrialKeys: true,      // optional run flags…
});

// Synchronous: server holds the connection. Beware Cloudflare 524 on long runs.
const sync = await jetty.runWorkflowSync("acme", "triage", { ticket });
```

### Why `runAndWait`

An async run returns a `workflow_id` shaped `"{collection}-{task}--{trajectoryId}"`.
The polling endpoint wants only the `trajectoryId` (the hex after the last `--`) —
a silent footgun if you pass the whole id. `runAndWait` parses it, polls
`getTrajectory`, and resolves on `completed` / throws on `failed | cancelled | archived`.
Need the parser directly?

```ts
import { parseWorkflowId } from "@jetty/sdk";
const { trajectoryId } = parseWorkflowId(started.workflow_id);
```

## Grading an agent output

`gradeWithJetty` is the eval primitive: hand it an agent output and a Jetty
**grading task** (a deterministic rubric or an LLM judge you deploy once), and it
uploads the output, runs the grader to completion, reads its grade file, and
labels the resulting trajectory — in one call. The grader is independent of the
agent, so it isn't the agent scoring itself.

```ts
import { JettyClient, gradeWithJetty } from "@jetty/sdk";

const jetty = new JettyClient();

const { grade, trajectoryId } = await gradeWithJetty<{ total: number; pass: boolean }>(
  jetty,
  "acme",
  "triage-grader",
  {
    files: [{ filename: "case.json", data: JSON.stringify({ ticket, triage }) }],
    useTrialKeys: true,                  // grade on Jetty's free trial, no key
    labels: (g) => ({                    // labels can read the grade
      "eval.config": "v1",
      "eval.grade": g.total.toFixed(2),
      "eval.pass": String(g.pass),
    }),
  },
);
// The trajectory is the durable, comparable eval record. Diff eval.* labels
// across configs to catch a regression before a customer does.
```

It accepts everything `runAndWait` does (`pollMs`, `timeoutMs`, `useTrialKeys`,
`onPoll`, …) plus:

| Option | Default | Purpose |
| --- | --- | --- |
| `files` | — (required) | The output(s) to grade, uploaded with the run. |
| `initParams` | `{}` | `init_params` for the grading task. |
| `gradeFile` | `"grade.json"` | Filename suffix to match, or a predicate over the storage key. |
| `parseGrade` | `JSON.parse(utf8)` | Parse the grade bytes into your grade type. |
| `labels` | — | A label map, or a function of the parsed grade. |
| `author` | `"jetty-sdk"` | Author recorded on the labels. |

> The full worked example — an agent A/B-eval that catches a regression — is
> [`examples/flue-jetty`](../../examples/flue-jetty): Flue runs the agent,
> `gradeWithJetty` grades and stores each run.

## Files

Uploads are multipart and land at `trajectory.init_params.file_paths[]`. Wire
your task's `step_configs` to `file_paths`, **not** `init_params.<name>`.

```ts
// Upload (Blob, ArrayBuffer, Buffer/typed array, or string).
const started = await jetty.runWithFiles(
  "acme", "triage", { ticket },
  [{ filename: "ticket.eml", data: emlBuffer, contentType: "message/rfc822" }],
);

// Download an output file by its storage key → bytes + filename.
const { bytes, filename } = await jetty.downloadFile("acme/results/report.pdf");
```

## Errors

Every error extends `JettyError`. Catch and narrow:

| Class | When |
| --- | --- |
| `JettyConfigError` | No token resolved (construction). |
| `JettyAuthError` | 401 / 403 — token missing, expired, or wrong scope. |
| `JettyNotFoundError` | 404 — collection/task/trajectory not found. |
| `JettyServerError` | 5xx (except 524) — retried with backoff first. |
| `JettyNetworkError` | DNS / connection failure — retried first. |
| `JettyTimeoutError` | Exceeded the per-request or `runAndWait` budget. |
| `JettyInProgressError` | **Cloudflare 524** — edge gave up, run is still going. Poll, don't retry. |
| `JettyRunFailedError` | Run reached `failed` / `cancelled` / `archived`. Carries `trajectoryError`. |

```ts
import { JettyRunFailedError, JettyInProgressError } from "@jetty/sdk";

try {
  await jetty.runAndWait("acme", "triage", { ticket });
} catch (e) {
  if (e instanceof JettyRunFailedError) console.error("run failed:", e.trajectoryError);
  else if (e instanceof JettyInProgressError) console.warn("still running — poll the trajectory");
  else throw e;
}
```

**Retry policy.** Network errors and transient 5xx are retried with exponential
backoff. `524` is **never** retried (it's mapped to `JettyInProgressError`).
GETs retry by default; non-idempotent mutations (POST/PUT/PATCH/DELETE) do not,
so a run is never accidentally fired twice — pass `{ retry: true }` to override.

## API surface

`JettyClient` covers the Jetty REST API:

- **Collections** — `listCollections`, `getCollection`, `getCollectionEnvironment`, `setEnvironmentVars`
- **Tasks** — `listTasks`, `getTask`, `createTask`, `updateTask`, `deleteTask`
- **Runs** — `runWorkflow`, `runWorkflowSync`, `runWithFiles`, `runAndWait`
- **Trajectories** — `listTrajectories`, `getTrajectory`, `getStats`
- **Labels** — `addLabel`
- **Files** — `downloadFile`
- **Trial keys** — `getTrialStatus`, `activateTrial`
- **Step templates** — `listStepTemplates`, `getStepTemplate`
- **Routines (schedules)** — `listRoutines`, `getRoutine`, `createRoutine`, `updateRoutine`, `deleteRoutine`, `pauseRoutine`, `resumeRoutine`, `runRoutineNow`, `listRoutineRuns`
- **Logs** — `getWorkflowLogs`

Plus helpers: `gradeWithJetty` (the eval primitive), `parseWorkflowId`,
`isTerminalStatus`, `resolveConfig`, and the full type set (`Trajectory`, `Step`,
`Label`, `WorkflowResponse`, …).

## Browser / custom fetch

The client uses global `fetch`. In environments without it (or to route through a
proxy), inject one: `new JettyClient({ token, fetch: myFetch })`. Token-file
resolution is Node-only; in the browser, pass `token` explicitly.

## License

MIT © Jetty.io
