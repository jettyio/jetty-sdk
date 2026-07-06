# Conference monitor

The live conference dashboard for the [`eve-jetty`](../) demo — folded into the example so
it runs off the **same `.env` as everything else**. Watch an **eve** agent answer support
tickets and **Jetty** judge each reply, live: ticket → agent reply → judge verdict,
streaming in as you type.

Around the card feed it tells the whole experiment story:

- **Per-dimension verdicts** — empathy / actionability / accuracy / policy bars per card,
  with a pulsing **⚠ POLICY** flag when the judge catches the agent overpromising (try the
  refund-demand trap ticket).
- **Traffic allocation** — the agent's Thompson bandit (fed by Jetty grades) made visible:
  the warm/terse/balanced split of recent runs, converging on the winner in front of the room.
- **Release gate** — SHIP ✅ / BLOCK ❌ once each arm has `GATE_MIN_RUNS` judged runs;
  blocking can post a one-shot **Slack alert** (the "the eval paged us" beat).
- **History strip** — rolling pass-rate per arm and a cost-vs-quality scatter, drawn from
  the same durable trajectories: the board dies with your laptop, the data doesn't.
- **Deep links** — every card links to its trajectory in the Jetty UI; the board is a lens,
  Jetty is the store.

## Run it

From the example root (`examples/eve-jetty`):

```bash
set -a && . ./.env && set +a   # or just rely on the monitor self-loading ../.env
npm run monitor                # → http://localhost:4600
```

Zero dependencies (Node 18+). It reads the shared `examples/eve-jetty/.env`, so the token,
collection, task, and gate/bandit thresholds match the agent's automatically — no separate
config. See the example's [README](../README.md#the-demo-arc-three-terminals--the-conference-monitor)
for the full three-terminal demo arc, and [`.env.example`](../.env.example) for every knob.

## Config (env — all from the shared `.env`)

| var | default |
|---|---|
| `JETTY_COLLECTION` | `jetty-vercel-demo` |
| `JETTY_AGENT_TASK` | `triage-live` (the task the agent ingests to and the monitor watches) |
| `MONITOR_PORT` | `4600` (falls back to `PORT`) |
| `POLL_MS` | `1000` |
| `LIMIT` | `100` (runs fetched per poll — feeds the history strip) |
| `GATE_MIN_RUNS` | `BANDIT_MIN_PER_ARM` (else `5`) — arms the gate at the same count the bandit stops exploring |
| `SLACK_ALERT_CHANNEL` | unset (set to a channel ID to post one alert per blocked arm) |
| `SLACK_BOT_TOKEN` | else `SLACK_BOT_OAUTH` |
| `JETTY_API_URL` | `https://flows-api.jetty.io` (same as the SDK) |
| `JETTY_UI_URL` | `https://jetty.io` (deep-link base) |
| `JETTY_API_TOKEN` | the same token the SDK uses |

## How it works

`server.mjs` polls `GET /api/v1/db/trajectories/{collection}/{task}` every second, flattens
each run (ticket from `init_params.input`, reply from the judge's `item` / the ingest step
output, score from the `eval.grade` label or the `simple_judge` step output, dimensions and
`policy_violation` from the judge's raw_result JSON with `eval.dim.*` labels as fallback),
computes the release gate server-side, and streams `{rows, gate, meta}` to the browser over
Server-Sent Events. `public/index.html` reconciles cards in place, so new runs slide in and
the judge verdict reveals the moment it lands; the allocation bar, trend chart, and
cost-vs-quality scatter are derived client-side from the same rows. The Jetty and Slack
tokens stay server-side. The Slack alert posts at most once per blocked arm per process.
