# eve × Jetty dashboard — Vercel build

The conference dashboard as a **serverless site**: a static page plus one `/api/runs`
function. Deploy it and watch a live eve × Jetty experiment from anywhere, off the same env
vars as the local [`monitor/`](../monitor/).

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/jettyio/jetty-sdk&root-directory=examples/eve-jetty/monitor-vercel&env=JETTY_API_TOKEN,JETTY_COLLECTION,JETTY_AGENT_TASK&envDescription=Your%20Jetty%20token%20plus%20the%20collection%20and%20task%20to%20watch&envLink=https://github.com/jettyio/jetty-sdk/tree/main/examples/eve-jetty/monitor-vercel&project-name=eve-jetty-monitor)

The button clones the repo, sets **Root Directory** to `examples/eve-jetty/monitor-vercel`,
prompts for the env vars below, and deploys. (Deploys the repo's **default branch** — until
this lands there, append `/tree/<branch>` to the `repository-url`.) No build step: Vercel
serves the static files and runs `api/runs.js` as a function.

## What's here

| File | Role |
|---|---|
| `index.html` + `pelly.svg` | The dashboard, served static. Polls `/api/runs` every ~1s (`?poll=<ms>` to change). |
| `api/runs.js` | Serverless function: one Jetty fetch → `{ rows, gate, meta }`. The token stays server-side. |
| `lib/jetty.js` | The trajectory→row/gate logic. Mirrors [`../monitor/server.mjs`](../monitor/server.mjs), minus the poll loop and Slack. |

**Why polling, not the local monitor's SSE?** Vercel functions are per-request — there's no
always-on process to hold a stream open, and no shared memory across invocations. The browser
polling a stateless function is the serverless-native shape, and it has no session-length limit.

## Configure (Vercel env vars — the same names as the demo `.env`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `JETTY_API_TOKEN` | ✅ | — | Read-only is enough. Kept server-side; never sent to the browser. |
| `JETTY_COLLECTION` | ✅ | `jetty-vercel-demo` | Must match the deployed agent. |
| `JETTY_AGENT_TASK` | ✅ | `triage-live` | The task the agent ingests to = the task this watches. |
| `JETTY_API_URL` | | `https://flows-api.jetty.io` | Point at your own mise if self-hosting. |
| `JETTY_UI_URL` | | `https://jetty.io` | Deep-link base for the per-card trajectory links. |
| `GATE_MIN_RUNS` | | `BANDIT_MIN_PER_ARM` else `5` | Judged runs/arm before the release gate decides. |
| `LIMIT` | | `100` | Runs fetched per poll (feeds the history strip). |

## Local preview

```bash
vercel dev          # runs the static page + function locally (needs the Vercel CLI + env vars)
```

Or, from the example root, the original SSE version: `npm run monitor` (see [`../monitor/`](../monitor/)).

## Notes

- **Read-only.** This never writes to Jetty — it's a lens over the trajectories your agent
  and judge produce. Point it at the same collection/task the deployed agent ingests to.
- **No Slack alerting here.** The gate's "page us on BLOCK" alert needs persistent state
  (an in-process de-dup), which a serverless function doesn't have. Use the local
  [`monitor/`](../monitor/) for that, or wire Vercel KV / Upstash into `api/runs.js`.
- See [`../DEMO.md`](../DEMO.md#deploy-it-to-vercel-end-to-end) for the full end-to-end
  deploy (agent + dashboard + judge).
