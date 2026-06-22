---
id: sdk
title: TypeScript SDK
sidebar_label: TypeScript SDK (@jetty/sdk)
description: Talk to Jetty from your own code with the typed @jetty/sdk client.
---

# TypeScript SDK — `@jetty/sdk`

`@jetty/sdk` is a typed, thin client over the Jetty REST API. It's the on-ramp
for using Jetty from your own code: run a task, poll a **trajectory** to
completion, read step inputs/outputs, and attach labels.

```bash
npm install @jetty/sdk
```

## Hello, trajectory

```ts
import { JettyClient } from "@jetty/sdk";

const jetty = new JettyClient();            // token from env or ~/.config/jetty/token

const ticket = {
  subject: "Password reset email never arrives",
  body: "Tried the reset link 3× over an hour — no email, checked spam.",
  tier: "pro",
};

const run = await jetty.runAndWait("acme", "triage", { ticket });
const { category, priority, draft_reply } = run.steps.triage.outputs;
//      "account_access"   2          "Hi Dana — sorry about the reset trouble…"
```

The whole run is now a Jetty **trajectory** — every step input/output captured,
replayable, and labelable.

## Authentication

The client resolves a token from (in order): an explicit `{ token }` argument,
the `JETTY_API_TOKEN` environment variable, then `~/.config/jetty/token`. Both
`mlc_*` API keys and Clerk JWTs work. Get a token at **jetty.io → Settings → API
Tokens**.

## What you can do

| Area | Methods |
| --- | --- |
| Runs | `runWorkflow`, `runWorkflowSync`, `runWithFiles`, `runAndWait` |
| Trajectories | `listTrajectories`, `getTrajectory`, `getStats` |
| Labels | `addLabel` |
| Collections & tasks | `listCollections`, `getCollection`, `listTasks`, `getTask`, `createTask`, … |
| Files | `runWithFiles`, `downloadFile` |
| Schedules | `listRoutines`, `createRoutine`, `pauseRoutine`, `runRoutineNow`, … |

## Sharp edges it handles for you

- **`workflow_id` parsing.** Async runs return `"{collection}-{task}--{trajectoryId}"`; the polling endpoint only wants the `trajectoryId`. `runAndWait` (and the exported `parseWorkflowId`) do the split.
- **Cloudflare 524.** Long synchronous runs return a 524 at the edge while the workflow keeps executing server-side. The SDK surfaces this as `JettyInProgressError` and never retries it — switch to polling.
- **Retries.** Transient 5xx and network errors retry with exponential backoff; non-idempotent mutations don't, so a run is never fired twice by accident.

## Worked example

The flagship example —
[`examples/flue-jetty`](https://github.com/jettyio/jetty-sdk/tree/main/examples/flue-jetty)
— **catches a regression before you ship**: run two versions of a triage agent
over a set of cases, grade each with a *different* model, and get one table
showing which version regressed. `npm run demo` prints it with no keys.

## Reference

Full API reference and error model:
[`@jetty/sdk` README](https://github.com/jettyio/jetty-sdk/tree/main/packages/sdk#readme).
