---
title: Jetty
description: Grade eve agent runs with Jetty. An independent grader, plus durable, labelled trajectories you can compare across versions and models.
---

# Jetty

You shipped an [eve](https://vercel.com/docs/eve) agent. You tweaked a prompt. Is it
better or worse? You can't tell from one reply. That's the *run, check, fix, rerun*
loop from [_How to build an AI agent_](https://jetty.io/guides/how-to-build-an-ai-agent),
and [Jetty](https://jetty.io) is the check.

eve owns the agent loop, and ships its own [evals](https://vercel.com/docs/eve) for
"did this commit break a rule." Jetty sits beside them: an **independent grader** (a
runbook the agent under test never sees, so a model can't grade its own output and
rubber-stamp a regression) and a **durable store**. Every run becomes a
[trajectory](https://docs.jetty.io) you can score, label, and diff across versions and
models, long after the CI job ended. (A check beside the agent beats a dashboard you
forget to open; the [Jetty blog](https://blog.jetty.io) makes the case.)

## Quickstart

```bash
npm install @jetty/sdk @jetty/eve
```

Jetty plugs into an eve agent as a mounted
[**extension**](https://eve.dev/docs/extensions) — `@jetty/eve` — plus the plain
`@jetty/sdk` for harness-side orchestration. One mount file gives the agent live
ingest of every turn into Jetty, an experiment bandit steered by Jetty grades, and a
tool that reads the scoreboard back:

```ts
// agent/extensions/jetty.ts — the file name is the namespace
import jetty from "@jetty/eve";

export default jetty({
  collection: process.env.JETTY_COLLECTION ?? "",   // empty → extension no-ops
  task: "triage-live",
  judgeMode: "simple_judge",                        // grade inline with a native Jetty judge
  arms: { warm: "…", terse: "…" },                  // your reply styles; the bandit is included
});
```

The complete worked example lives at
[`jettyio/jetty-sdk` → `examples/eve-jetty`](https://github.com/jettyio/jetty-sdk/tree/main/examples/eve-jetty).

## Overview

eve's agent is a directory you run with `npx eve dev` (or deploy to Vercel). Drive it
over the typed `eve/client`, then hand the reply to a Jetty grading task and wait for
the trajectory. The grade comes back as a row you can label and compare.

```ts
import { Client } from "eve/client";
import { JettyClient, gradeWithJetty } from "@jetty/sdk";

const eve = new Client({ host: process.env.EVE_URL ?? "http://127.0.0.1:2000" });
const jetty = new JettyClient(); // JETTY_API_TOKEN from env or ~/.config/jetty/token

// 1. eve runs the agent (it owns the loop).
const turn = await (await eve.session().send(prompt)).result();

// 2. Jetty grades it server-side, with a grader that isn't the author —
//    upload, run the grader, read the grade, and label, in one call.
const { grade, trajectoryId } = await gradeWithJetty(jetty, "acme", "triage-grader", {
  files: [{ filename: "case.json", data: turn.message ?? "" }],
  useTrialKeys: true,                          // grade on Jetty's free trial, no provider key
  labels: (g) => ({ "eval.grade": String(g.total) }), // labels can read the grade
});
```

Each grade is a Jetty trajectory: the inputs, outputs, grade, and cost, ready to
replay. Compare the `eval.*` labels across configs to see which version slipped.

> **Native reporter.** For eve's own evals, a `Jetty()` eval reporter drops into
> `evals.config.ts` exactly where the built-in `Braintrust(...)` reporter goes, so every
> `eve eval` result lands in Jetty automatically:
> `import { Jetty } from "@jetty/eve/reporter"` →
> `defineEvalConfig({ reporters: [Jetty()] })`.

## Configure

| Variable | Required | Purpose |
| --- | --- | --- |
| `JETTY_API_TOKEN` | yes | Jetty API token (also read from `~/.config/jetty/token`). |
| `JETTY_COLLECTION` | yes | Collection that owns the grading task. |
| `JETTY_GRADE_TASK` | yes | The grading runbook (e.g. `triage-grader`). |
| `JETTY_USE_TRIAL_KEYS` | no | Grade on Jetty's free trial, no provider key (see below). |
| `EVE_URL` | for the agent | Where the eve agent is reachable (`npx eve dev` serves `127.0.0.1:2000`). |
| `AI_GATEWAY_API_KEY` / `VERCEL_OIDC_TOKEN` | for the agent | eve resolves models through AI Gateway, so the agent needs one of these. |

> **Credentials.** Put anything sensitive in `secretParams`, which the server keeps out
> of the stored trajectory. Don't put secrets in `initParams`; that field is persisted.
> The SDK never logs your token. Tokens resolve from a constructor arg, then
> `JETTY_API_TOKEN`, then `~/.config/jetty/token`.

Requires `@jetty/sdk` 0.2.0+ (for `gradeWithJetty`) and, for the `@jetty/eve`
extension, `eve` 0.24+ on Node 24+ (mounted extensions landed in eve 0.22.3).

## What Jetty captures

| eve | Jetty |
| --- | --- |
| Agent output (the draft) | The input the grading runbook scores |
| Grade (1–5) | Label `eval.grade` on the trajectory |
| Pass / fail vs. the bar | Label `eval.pass` |
| Per-run cost (estimated from `step.completed` token usage) | Label `eval.cost_est_usd` |
| Which agent config / version | Label `eval.config` |
| The whole graded run | A [trajectory](https://docs.jetty.io): inputs, outputs, steps, replayable |

> eve reports token usage but no dollar cost, so the example estimates `$/run` from
> tokens and a small per-model price table (`src/cost.ts`). Tune it to your real rates.

## Protect sensitive content

Trajectories persist step inputs and outputs. They're content-bearing. Put credentials
in `secretParams` (kept out of the stored trajectory), not `initParams`. If a draft can
carry PII, redact it before grading or grade a hash or summary instead. Treat trajectory
storage like any other logging surface.

## Run on Jetty's free trial (no API key)

Jetty grading runs server-side, and every collection gets a free trial: 10 runs,
auto-activated, on Jetty's keys. Set `JETTY_USE_TRIAL_KEYS=true` and you need no
provider key to grade. Sonnet and most models are covered; Opus-class is excluded.

The trial covers the server-side Jetty grader. The eve agent runs on your machine (or
on Vercel), so the agent still uses its own AI Gateway credential. You can exercise
Jetty's grading and trajectories with zero keys, and the offline demo (`npm run demo`)
needs none at all.

## Verify

- `npm run demo` prints the verdict table and opens a styled `report.html`. No keys, no eve.
- `npm run deploy-grader` creates the grading runbook in your collection.
- `npx eve dev` serves the agent; `EVAL_TICKETS=2 npm run ab-eval` prints per-run grades
  and the verdict, opens `report.html`, and writes a labelled trajectory you can open at
  `https://flows.jetty.io/<collection>/triage-grader`.

## See also

- [`@jetty/sdk` on npm](https://www.npmjs.com/package/@jetty/sdk) · [API reference](https://github.com/jettyio/jetty-sdk/tree/main/packages/sdk#readme)
- [The worked example](https://github.com/jettyio/jetty-sdk/tree/main/examples/eve-jetty) · [step-by-step tutorial](TUTORIAL.md)
- [eve docs](https://vercel.com/docs/eve) · [How to build an AI agent](https://jetty.io/guides/how-to-build-an-ai-agent) · [Jetty docs](https://docs.jetty.io) · [blog](https://blog.jetty.io)
