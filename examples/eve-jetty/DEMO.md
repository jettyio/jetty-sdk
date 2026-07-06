# Run the live demo (one command)

Watch an **eve** agent answer support tickets while **Jetty** judges every reply in real
time: ticket → agent reply → judge verdict, streaming onto a dashboard. The agent tests
three personas (**warm**, **terse**, and a policy-safe **balanced**), a bandit steers
traffic toward the winner using the live grades, and a **release gate** ships the winner
and blocks the weaker arms once each has enough judged runs.

> **▶️ Prefer to watch first?** [**See the demo**](media/jetty-eve-demo.mov) — the 3-arm bandit
> exploring, the judge scoring each reply live, and the release gate shipping the winner. (Opens
> GitHub's player.)

One command starts the whole thing — you don't fire off each piece by hand:

```bash
cd examples/eve-jetty
npm start                 # deploy the judge, then run the agent + monitor together
```

Then open **http://localhost:4600** and either type a ticket into the agent or let it drive
itself with `npm start -- --feed`.

---

## What you need

Two secrets, both in one `.env`:

| Secret | Why | Get it |
|---|---|---|
| **`JETTY_API_TOKEN`** | Jetty runs the judge and stores every run as a trajectory. | [jetty.io](https://jetty.io) → Settings → API Tokens |
| **`OPENROUTER_API_KEY`** | The eve agent runs on **your machine**, so it needs its own model key to draft replies. `npm start` also pushes this key to your Jetty collection so the server-side judge can use it too — so this one key covers both. | [openrouter.ai/keys](https://openrouter.ai/keys) |

> **Why not just a Jetty key?** Jetty's free trial keys cover the *server-side judge*, but
> the agent itself runs locally and always needs a model credential. One OpenRouter key is
> the simplest way to power both. (Have a Vercel AI Gateway key instead? Set
> `AI_GATEWAY_API_KEY` and the agent uses that; drop `OPENROUTER_API_KEY` and add
> `JETTY_USE_TRIAL_KEYS=true` to grade on the trial.)

Node 20+.

---

## Setup (once)

```bash
# 1. From the repo root — install the workspace and build the SDK
npm install
npm run build -w @jetty/sdk

# 2. Into the example, create your .env from the template
cd examples/eve-jetty
cp .env.example .env          # (npm start also does this for you on first run)

# 3. Open .env and fill in the two secrets:
#      JETTY_API_TOKEN=mlc_...
#      OPENROUTER_API_KEY=sk-or-...

# 4. Sanity-check your config without launching anything
npm start -- --check
```

`--check` prints exactly what will run and flags a missing token or model key. When it says
**✓ config looks good**, you're ready.

Everything reads this one `examples/eve-jetty/.env`, so the agent, the bandit, the judge,
and the monitor all point at the same **collection** and **task** and arm the gate at the
same threshold — nothing to keep in sync by hand.

> **Using your own collection?** The demo defaults to `JETTY_COLLECTION=jetty-vercel-demo`.
> If your token can't write to it (deploy fails with a 403), set `JETTY_COLLECTION` in `.env`
> to a collection your token owns and re-run.

---

## Launch

```bash
npm start
```

What it does, in order:

1. **Deploys the judge** — makes your task a native Jetty `simple_judge` step (idempotent;
   skip with `--no-judge` once it's deployed).
2. **Starts the agent** — `npx eve dev` on http://127.0.0.1:2000.
3. **Starts the monitor** — the conference dashboard on http://localhost:4600.
4. Prints a **demo is live** banner once both are up. **Ctrl-C stops everything.**

Then drive it:

- **Type** a support ticket into the eve dev chat, **or**
- **Auto-feed** the sample tickets (including the policy-trap ticket) hands-free:
  ```bash
  npm start -- --feed
  ```

### Flags

| Flag | Effect |
|---|---|
| `--feed` | After startup, auto-send the sample tickets (`FEED_ROUNDS=2` in `.env` loops them so the bandit converges). |
| `--no-judge` | Skip the one-time judge deploy (it's already deployed). |
| `--check` | Validate `.env` and print the plan, without launching. |
| `--help` | Usage. |

Pass flags after `--`, e.g. `npm start -- --feed --no-judge`.

---

## What you're watching (the demo arc)

Runs stream in while the bandit explores all three arms → **trap tickets** ("confirm my
refund RIGHT NOW", "waive my fee") tempt an overpromise; a warm reply that capitulates gets
flagged **⚠ POLICY**, while the **balanced** arm is built to sidestep them → once each arm
has `GATE_MIN_RUNS` judged runs the gate **ships the winner and blocks the weaker arms**
(firing a Slack alert per blocked arm if you set `SLACK_ALERT_CHANNEL`) → the allocation bar
converges on whichever arm the live grades favor. Measurement → decision → action, all
driven by Jetty grades. Every card deep-links to its
trajectory in the Jetty UI.

---

## The pieces (all one `.env`)

| Process | Command | Port | Reads |
|---|---|---|---|
| Agent (+ bandit + judge hook) | `npx eve dev` | 2000 | `JETTY_*`, `EVE_MODEL`, `OPENROUTER_API_KEY`, `JUDGE_MODE`, `BANDIT_*` |
| Conference monitor | `npm run monitor` (`monitor/server.mjs`) | 4600 | `JETTY_*`, `MONITOR_PORT`, `GATE_MIN_RUNS`←`BANDIT_MIN_PER_ARM`, `SLACK_*` |
| Judge deploy (one-shot) | `npm run deploy-judge` | — | `JETTY_*`, `JUDGE_MODEL*`, `OPENROUTER_API_KEY` |
| Feeder (optional) | `npm run feed` | — | `EVE_URL`, `FEED_*` |

`npm start` orchestrates all of these. You can still run any of them individually if you
want separate terminals — the [main README](README.md) covers the manual three-terminal
flow and the simpler `npm run board`.

---

## Deploy it to Vercel (end-to-end)

`npm start` is the local demo. To host it — a public dashboard and an always-on agent —
there are **two deployable surfaces** plus a one-time Jetty setup. Jetty itself is already
hosted, so it just needs the same env vars.

| Piece | Where it goes | How |
|---|---|---|
| **Dashboard** | Vercel (static + one function) | one-click button below |
| **Agent** (+ bandit + judge hook) | Vercel (eve is a Vercel framework) | `eve deploy` |
| **Judge task** | Jetty (one-time setup, not a deploy) | `npm run deploy-judge` once |
| **Jetty** | already hosted | set env vars |

### 1. Dashboard — one click

The dashboard is refactored to be serverless-native (a static page that polls a stateless
`/api/runs` function, so there's no long-lived process or session limit). Deploy it from
[`monitor-vercel/`](monitor-vercel/):

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/jettyio/jetty-sdk&root-directory=examples/eve-jetty/monitor-vercel&env=JETTY_API_TOKEN,JETTY_COLLECTION,JETTY_AGENT_TASK&envDescription=Your%20Jetty%20token%20plus%20the%20collection%20and%20task%20to%20watch&envLink=https://github.com/jettyio/jetty-sdk/tree/main/examples/eve-jetty/monitor-vercel&project-name=eve-jetty-monitor)

Vercel prompts for `JETTY_API_TOKEN`, `JETTY_COLLECTION`, and `JETTY_AGENT_TASK` — the token
stays server-side in the function, never in the browser. (Deploys the repo's default branch;
see [`monitor-vercel/README.md`](monitor-vercel/README.md) for the full env table and the
branch note.)

### 2. Agent — `eve deploy`

eve is Vercel's own framework, so the agent deploys natively:

```bash
cd examples/eve-jetty
eve link            # link a Vercel project + pull AI Gateway credentials
eve deploy          # deploy the agent to Vercel production
```

Then set the agent project's env vars (Vercel dashboard or `vercel env add`) — the **same
names** as your `.env`: `JETTY_API_TOKEN`, `JETTY_COLLECTION`, `JETTY_AGENT_TASK`,
`JETTY_AUTHOR`, `JUDGE_MODE=simple_judge`, and the `BANDIT_*` knobs. `eve link` handles the
model credential (AI Gateway); or set `OPENROUTER_API_KEY`.

### 3. Judge task — once

The judge is a Jetty task, created once per collection (idempotent). Run it locally with your
token, or point `--check`/`npm start` at the deployed setup:

```bash
npm run deploy-judge
```

Point the dashboard and the agent at the **same** `JETTY_COLLECTION` + `JETTY_AGENT_TASK`
and everything lines up — same "one shared config," just as Vercel env vars instead of a file.

> **Caveats worth knowing.**
> - **A public agent spends your model budget.** The HTTP channel's `vercelOidc()` rejects
>   random traffic, but a chat UI or the feeder needs a credential — add `jwtHmac()` in
>   `agent/channels/eve.ts` with `EVE_AUTH_TOKEN` (already scaffolded) so the room can't
>   rack up spend, or drive it yourself with `npm run feed`.
> - **Slack gate-alerts aren't in the serverless dashboard** (they need persistent de-dup
>   state). Run the local [`monitor/`](monitor/) for that, or wire Vercel KV into `api/runs.js`.
> - **No session-length limit** — polling a per-request function survives an all-day booth,
>   which a held-open SSE stream on serverless would not.

---

## Troubleshooting

- **`✗ JETTY_API_TOKEN is missing or still the placeholder`** — paste your real token into
  `.env` (not the `mlc_xxxx…` placeholder).
- **`⚠ No model credential for the local agent`** — set `OPENROUTER_API_KEY` (or an AI
  Gateway credential). The agent can't draft replies without one; the chat will error.
- **`deploy-judge failed` / 403** — your token can't write to `JETTY_COLLECTION`. Point it
  at a collection you own (see "Using your own collection" above).
- **Dashboard stays empty** — no runs are landing. Confirm the agent, the judge, and the
  monitor all use the same `JETTY_AGENT_TASK` (they do by default; `npm start -- --check`
  prints it), and that you've sent a ticket (`--feed` or typed one).
- **Port already in use (2000 or 4600)** — stop the other process, or change `MONITOR_PORT`
  in `.env` (the agent's 2000 comes from eve; set `EVE_URL` to match if you remap it).
- **No keys at all?** The offline demo needs none: `npm run demo` prints the verdict table
  and opens a styled report.

## See also

- [`README.md`](README.md) — the full example (Part 1 A/B, Part 2 online, the native reporter).
- [`monitor/README.md`](monitor/README.md) — the dashboard's config knobs.
- [`.env.example`](.env.example) — every variable, documented.
