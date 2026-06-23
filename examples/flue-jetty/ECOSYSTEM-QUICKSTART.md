---
title: Jetty
description: Grade Flue agent runs with Jetty. An independent grader, plus durable, labelled trajectories you can compare across versions.
---

# Jetty

You shipped a Flue agent. You tweaked a prompt. Is it better or worse? You can't
tell from one reply. That's the *run, check, fix, rerun* loop from
[_How to build an AI agent_](https://jetty.io/guides/how-to-build-an-ai-agent),
and [Jetty](https://jetty.io) is the check.

Flue owns the agent loop. Jetty grades each output and keeps it: every run
becomes a [trajectory](https://docs.jetty.io) you can score, label, and diff
across versions, so a regression shows up before a customer finds it. (Why a
check beside the agent beats a dashboard you forget to open: the
[Jetty blog](https://blog.jetty.io).)

## Quickstart

```bash
npm install @jetty/sdk
```

There's no `flue add tooling jetty` package. Jetty plugs in through its SDK. The
complete worked example lives at
[`jettyio/jetty-sdk` → `examples/flue-jetty`](https://github.com/jettyio/jetty-sdk/tree/main/examples/flue-jetty).

## Overview

In a Flue workflow, draft with the agent, then hand the draft to a Jetty grading
task and wait for the trajectory. The grade comes back as a row you can label and
compare.

```ts
import { defineWorkflow } from "@flue/runtime";
import * as v from "valibot";
import { JettyClient, gradeWithJetty } from "@jetty/sdk";
import { triageAgent } from "../agent.js";

const jetty = new JettyClient(); // JETTY_API_TOKEN from env or ~/.config/jetty/token

export default defineWorkflow({
  agent: triageAgent,
  input: v.object({ ticket: v.any() }),
  async run({ harness, input }) {
    // 1. Flue runs the agent (it owns the loop).
    const session = await harness.session();
    const draft = await session.prompt(JSON.stringify(input.ticket));

    // 2. Jetty grades it server-side, with a grader that isn't the author —
    //    upload, run the grader, read the grade, and label, in one call.
    const { grade, trajectoryId } = await gradeWithJetty(jetty, "acme", "triage-grader", {
      files: [{ filename: "case.json", data: draft.text }],
      useTrialKeys: true,                          // grade on Jetty's free trial, no provider key
      labels: (g) => ({ "eval.grade": String(g.total) }), // labels can read the grade
    });

    return { grade, gradeTrajectoryId: trajectoryId };
  },
});
```

Each grade is a Jetty trajectory: the inputs, outputs, score, and cost, ready to
replay. Compare the `eval.*` labels across configs to see which version slipped.

## Configure

| Variable | Required | Purpose |
| --- | --- | --- |
| `JETTY_API_TOKEN` | yes | Jetty API token (also read from `~/.config/jetty/token`). |
| `JETTY_COLLECTION` | yes | Collection that owns the grading task. |
| `JETTY_GRADE_TASK` | yes | The grading runbook (e.g. `triage-grader`). |
| `JETTY_USE_TRIAL_KEYS` | no | Grade on Jetty's free trial, no provider key (see below). |
| `ANTHROPIC_API_KEY` | for the agent | The Flue agent runs on your machine, so it needs a model key. |

> **Credentials.** Put anything sensitive in `secretParams`, which the server
> keeps out of the stored trajectory. Don't put secrets in `initParams`; that
> field is persisted. The SDK never logs your token. Tokens resolve from a
> constructor arg, then `JETTY_API_TOKEN`, then `~/.config/jetty/token`.

Requires `@jetty/sdk` 0.2.0+ (for `gradeWithJetty`).

## What Jetty captures

| Flue | Jetty |
| --- | --- |
| Agent output (the draft) | The input the grading runbook scores |
| Grade (1–5) | Label `eval.grade` on the trajectory |
| Pass / fail vs. the bar | Label `eval.pass` |
| Per-run cost (`response.usage`) | Label `eval.cost_usd` |
| Which agent config / version | Label `eval.config` |
| The whole graded run | A [trajectory](https://docs.jetty.io): inputs, outputs, steps, replayable |

## Protect sensitive content

Trajectories persist step inputs and outputs. They're content-bearing. Put
credentials in `secretParams` (kept out of the stored trajectory), not
`initParams`. If a draft can carry PII, redact it before grading or grade a hash
or summary instead. Treat trajectory storage like any other logging surface.

## Run on Jetty's free trial (no API key)

Jetty grading runs server-side, and every collection gets a free trial: 10 runs,
auto-activated, on Jetty's keys. Set `JETTY_USE_TRIAL_KEYS=true` and you need no
provider key to grade. Sonnet and most models are covered; Opus-class is excluded.

The trial covers server-side Jetty runs. The Flue agent runs on your machine, so
the agent still uses your own model key. You can exercise Jetty's grading and
trajectories with zero keys, and the offline demo (`npm run demo`) needs none at
all.

## Verify

- `npm run demo` prints the verdict table and opens a styled `report.html`. No keys.
- `npm run deploy-grader` creates the grading runbook in your collection.
- `npx flue run eval --target node --input '{"tickets":2}'` prints per-run
  scores and the verdict, opens `report.html`, and writes a labelled trajectory
  you can open at `https://flows.jetty.io/<collection>/triage-grader`.

## See also

- [`@jetty/sdk` on npm](https://www.npmjs.com/package/@jetty/sdk) · [API reference](https://github.com/jettyio/jetty-sdk/tree/main/packages/sdk#readme)
- [The worked example](https://github.com/jettyio/jetty-sdk/tree/main/examples/flue-jetty) · [step-by-step tutorial](TUTORIAL.md)
- [How to build an AI agent](https://jetty.io/guides/how-to-build-an-ai-agent) · [docs](https://docs.jetty.io) · [blog](https://blog.jetty.io)
