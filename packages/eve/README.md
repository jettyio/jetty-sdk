# @jetty/eve

Jetty × [eve](https://eve.dev): mount live Jetty grading into any eve agent as an
[extension](https://eve.dev/docs/extensions), and report `eve eval` results into Jetty
as durable trajectories.

Two independent pieces, use either or both:

1. **The extension** (the package's default export) — mounted under `agent/extensions/`,
   it contributes, under your mount's namespace:
   - **`hooks/ingest`** — every finished turn lands in Jetty as a durable, labelled
     trajectory (`eval.config`, `eval.source`, `cost_est_usd`), ungraded for an
     out-of-band grader — or judged inline by a native Jetty `simple_judge` task
     (`judgeMode: "simple_judge"`), which also writes `eval.grade` / `eval.pass` /
     `eval.dim.*` / `eval.policy_violation`.
   - **`instructions/arm`** — a per-turn dynamic-instructions resolver running an
     episodic Thompson-sampling bandit over your configured reply-style `arms`,
     rewarded by the pass-rates read back from Jetty labels. Jetty's grades are the
     signal the agent optimizes, not a dashboard.
   - **`tools/experiment`** — a tool the model can call to report the experiment
     (per-arm judged runs, pass rates, leader). Composes as `<namespace>__experiment`.
2. **The `Jetty()` eval reporter** (`@jetty/eve/reporter`) — drops into
   `evals.config.ts` where eve's `Braintrust(...)` goes; every `eve eval` result is
   pushed to Jetty with one `ingestTrajectory` call. (Reporters are eval-runner
   config, not an agent capability, so this is a plain export, not a contribution.)

## Mount

```ts
// agent/extensions/jetty.ts   ← the file name is the namespace
import jetty from "@jetty/eve";

export default jetty({
  collection: process.env.JETTY_COLLECTION ?? "",   // empty → extension no-ops
  task: "triage-live",
  judgeMode: "simple_judge",
  arms: {
    warm: "write the reply as a warm, specific first response…",
    terse: "write the reply as a single terse sentence…",
  },
  contract: "Respond with ONLY the JSON object { … } — no prose.",
});
```

Config is validated (zod) and binds once at mount; every knob has a sensible default —
see `extension/extension.ts` for the full schema (bandit pacing, pass bar, token
prices). With an empty `collection` every contribution degrades to a no-op or a fair
coin, so the agent runs without Jetty credentials.

Cross-contribution bookkeeping (which arm a turn played, the turn's captured
input/reply/usage) uses eve's `defineState`, auto-scoped to this package — no globals,
no collisions with the consuming agent.

## Typed tool results & overrides

Narrow the experiment tool's result in your own hook:

```ts
import { toolResultFrom } from "eve/tools";
import { experiment } from "@jetty/eve/tools";

const match = toolResultFrom(event.data.result, experiment); // typed output or undefined
```

To gate or replace a contribution, author your mount as a directory
(`agent/extensions/jetty/extension.ts`) and add override slots beside it — e.g.
`tools/experiment.ts` re-defining the tool with an approval, or `disableTool()` to
drop it. See the [extensions docs](https://eve.dev/docs/extensions#overrides).

## Reporter

```ts
// evals/evals.config.ts
import { defineEvalConfig } from "eve/evals";
import { Jetty } from "@jetty/eve/reporter";

export default defineEvalConfig({ reporters: [Jetty()] });
```

Needs `JETTY_API_TOKEN` + `JETTY_COLLECTION` (or pass `collection`/`project` in code).
The reporter never fails an eval run: unreachable Jetty logs a warning and the run
continues; with no collection set it no-ops, so the config is safe to commit.

## Worked example

`examples/eve-jetty` in this repo mounts the extension over a support-triage agent and
runs the full loop live: answer → grade → traffic shifts → release gate. It's the
end-to-end demo of everything above.

## Requirements

- eve ≥ 0.24 (peer dependency — your app provides it), Node ≥ 24
- A Jetty API token (`JETTY_API_TOKEN`); the ingest endpoint
  (`POST /api/v1/trajectories/{collection}/{task}/ingest`) on the target mise
