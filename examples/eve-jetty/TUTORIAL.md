# Tutorial: catch a regression with `@jetty/sdk` + eve

A step-by-step walkthrough for a developer who just checked out this repo. You'll run an
agent eval that compares two versions of a support-triage agent and tells you which one
regressed: first offline (no keys, ~10 seconds), then live.

**What you're building:** the agent runs on [eve](https://vercel.com/docs/eve) (Vercel's
filesystem-first framework where an agent is a directory); Jetty grades every draft with
an independent rubric and stores each run as a trajectory; a small harness loops over two
configs and prints one verdict table.

```
TICKETS: 2   GRADER: rubric (independent)
 config        pass   avg   $/run
 v1 (warm)    2/2    4.7   0.0093  ✅
 v2 (terse)   0/2    2.7   0.0032  ❌  regressed
→ v2 (terse) is cheaper but fails the bar (4.0). Keep v1 (warm).
```

---

## 0. Prerequisites

- **Node 18+** for the offline demo; **Node 24+** for the live run (eve requires it).
- For the **offline** demo (Steps 1–3): **nothing**. No keys, no account, no eve.
- For the **live** run (Steps 4–7):
  - A **Jetty API token** for a collection you can write to. Get one at [jetty.io](https://jetty.io) → Settings → API Tokens.
  - A **model credential** for the **local eve agent**: an `AI_GATEWAY_API_KEY` (or `VERCEL_OIDC_TOKEN`), since eve resolves models through Vercel AI Gateway. No gateway? Set `OPENROUTER_API_KEY` and the agent routes through OpenRouter instead.
  - The **Jetty grading runs on your free trial**, so no provider key is needed for that part.

> **Three levels of "do I need a key?"**
> 1. **Offline demo** (`npm run demo`): no keys at all.
> 2. **Grading on Jetty**: covered by the **free trial** (10 runs, auto-activated).
> 3. **The live eve agent** runs via `npx eve dev` and uses your AI Gateway or OpenRouter key.

---

## 1. Clone this repo and build

```bash
git clone https://github.com/jettyio/jetty-sdk.git
cd jetty-sdk
npm install                    # installs the SDK, the example, and eve (one workspace install)
npm run build -w @jetty/sdk    # the example imports the built SDK
```

> The `-w @jetty/sdk` flag is monorepo-only. To use the SDK in your *own* app, see
> [Using `@jetty/sdk` in your own project](#using-jettysdk-in-your-own-project).

## 2. Move into the example

```bash
cd examples/eve-jetty
```

## 3. Run the offline demo (no keys)

```bash
npm run demo
```

You should see the verdict table immediately, and `report.html` opens in your browser: a
styled verdict and per-run breakdown (the same report the live run produces). This is a
deterministic stand-in with the same data shape, no spend, no eve, no network. If you only
want to understand the example, you can stop here.

---

## 4. Configure credentials (for the live run)

```bash
cp .env.example .env
```

Edit `.env`:

```ini
AI_GATEWAY_API_KEY=...                 # or VERCEL_OIDC_TOKEN, or OPENROUTER_API_KEY
JETTY_API_TOKEN=mlc_...                # your Jetty token
JETTY_COLLECTION=your-collection       # a collection your token can write to
JETTY_GRADE_TASK=triage-grader         # leave as-is
EVE_URL=http://127.0.0.1:2000          # where `npx eve dev` serves the agent
```

Load it into your shell (the scripts read `process.env`, they don't auto-load `.env`):

```bash
set -a && . ./.env && set +a
```

> `.env` is gitignored. Don't commit it.

## 5. Deploy the grader (one time)

The harness calls a Jetty runbook that scores each draft. Deploy it into your collection:

```bash
npm run deploy-grader
```

This creates the `triage-grader` task from [`grader/RUNBOOK.md`](grader/RUNBOOK.md) (and
pushes a provider key into the collection if you set one). Re-running it updates the task.

> **No provider key?** The grader can run on Jetty's free trial. See
> [Run it on Jetty's free trial](#run-it-on-jettys-free-trial).

## 6. Serve the agent, then run the live A/B

In one terminal, serve the eve agent (Node 24+):

```bash
npx eve dev            # http://127.0.0.1:2000
```

In another, run the A/B. Each ticket is a real server-side grade, so start with 2:

```bash
EVAL_TICKETS=2 npm run ab-eval
```

You'll see a line per run, then the verdict table:

```
  v1 (warm) · reset: 4.7 PASS
  v1 (warm) · double-charge: 4.7 PASS
  v2 (terse) · reset: 2.7 fail
  v2 (terse) · double-charge: 2.7 fail

TICKETS: 2   GRADER: rubric (independent)
 config        pass   avg   $/run
 v1 (warm)    2/2    4.7   0.0093  ✅
 v2 (terse)   0/2    2.7   0.0032  ❌  regressed
→ v2 (terse) is cheaper but fails the bar (4.0). Keep v1 (warm).
```

Then it writes **`report.html`** and opens it: the verdict, a per-run breakdown, and links
to each Jetty trajectory.

### Run it on Jetty's free trial

Jetty gives every collection a **free trial** (10 runs, auto-activated) on Jetty's keys, so
you can run the **grading** with no provider key:

```bash
JETTY_USE_TRIAL_KEYS=true EVAL_TICKETS=2 npm run ab-eval
```

The trial covers **server-side Jetty runs** (the grader). The eve agent runs on your
machine, so the *full* live run still needs a model credential for the agent, but you can
see Jetty's grading and trajectories on the trial, and `npm run demo` needs no keys at all.
(Trial covers Sonnet and most models; Opus-class is excluded.)

That's the whole point: **the eval caught that the terse config regressed** before it ever
reached a customer.

## 7. Inspect what got stored

Every grade is a Jetty **trajectory**, labelled with `eval.config`, `eval.grade`,
`eval.pass`, and `eval.cost_est_usd`. View them in the Jetty UI
(`https://flows.jetty.io/<collection>/triage-grader`) or from code:

```ts
import { JettyClient } from "@jetty/sdk";
const jetty = new JettyClient(); // reads JETTY_API_TOKEN
const list = await jetty.listTrajectories(process.env.JETTY_COLLECTION!, "triage-grader", 5);
for (const t of list.trajectories) {
  const full = await jetty.getTrajectory(process.env.JETTY_COLLECTION!, "triage-grader", t.trajectory_id);
  const labels = Object.fromEntries(full.labels.map((l) => [l.key, l.value]));
  console.log(t.trajectory_id, labels["eval.config"], labels["eval.grade"], labels["eval.pass"]);
}
```

---

## 8. Part 2 — the live online experiment (watch Jetty grade as you type)

Steps 1–7 are a *controlled batch*: the harness runs both configs over the same tickets and
grades each inline. Part 2 is the **online** shape teams actually ship — one agent
randomizes its own behaviour per request, every run is logged, and grading happens **out of
band**. It's built to demo live: you type, Jetty lights up.

You need the same creds as Step 4 and the grader from Step 5. Then open three terminals:

```bash
npx eve dev            # terminal 1 — the agent (Node 24+)
npm run grade-watch    # terminal 2 — the out-of-band grader
npm run board          # terminal 3 — the scoreboard, then open http://localhost:4500
```

Type a support request into the `eve dev` chat (e.g. "my password reset email never
arrives"). Within a second a row appears on the board tagged `warm` or `terse` and marked
"grading…"; a beat later it flips to a green pass or red fail. Type a few and the
warm-vs-terse pass-rates pull apart.

What each piece does:

- **`agent/instructions/arm.ts`** — a dynamic-instructions resolver that fires on
  `turn.started` (server-side, once per turn) and randomly applies the warm or terse style.
  Because it lives in the agent, *every* turn you type is A/B'd, not just scripted ones.
- **`agent/hooks/ingest.ts`** — a hook that fires on `turn.completed`, assembles the
  finished turn (the triage JSON + token usage), and calls `ingestTrajectory` to record it
  in Jetty as an **ungraded** trajectory tagged `eval.config`.
- **`src/grade-watcher.ts`** (`npm run grade-watch`) — polls for ungraded runs, scores each
  with the **independent** `triage-grader`, and writes `eval.grade` / `eval.pass` back onto
  the run with `addLabel`. Grading never blocks the chat.
- **`src/live-board.ts`** (`npm run board`) — a 2-second-poll board that renders the runs
  and their grade labels, so the scoreboard updates as grades land.

No one to type for you (or just rehearsing)? `npm run feed` sends the sample tickets into
`eve dev` as if typed.

> **Why a separate board, not the Jetty UI?** The Jetty UI is durable storage, not a live
> ticker — its run list polls slowly and doesn't surface labels inline. The board is a thin
> demo view over the same trajectories you can query with `listTrajectories` later.

> **Reliability tip for a live demo.** Each grade spins up a sandbox, so run
> `npm run deploy-grader` ahead of time and send one warm-up ticket before you present.

---

## How it works (the pieces)

| File | Role |
|------|------|
| [`agent/instructions.md`](agent/instructions.md) + [`agent/agent.ts`](agent/agent.ts) | The eve agent as a directory: always-on system prompt + runtime config. |
| [`agent/channels/eve.ts`](agent/channels/eve.ts) | The HTTP channel the harness drives (auth config). |
| [`src/tickets.ts`](src/tickets.ts) | The eval cases + the two configs (`v1` warm, `v2` terse). |
| [`src/agent-prompt.ts`](src/agent-prompt.ts) | Builds the per-config message and parses the triage JSON back out. |
| [`src/ab-eval.ts`](src/ab-eval.ts) | The live loop: for each config × ticket → drive eve via `eve/client` → `gradeWithJetty` → collect. |
| [`src/cost.ts`](src/cost.ts) | Estimates per-run cost from eve token usage (eve has no dollar-cost field). |
| [`src/eval.ts`](src/eval.ts) | `aggregate()` (pass-rate/grade/cost) + `renderVerdict()` (the table). |
| [`grader/RUNBOOK.md`](grader/RUNBOOK.md) | The independent grader: a deterministic Python rubric. |
| [`agent/instructions/arm.ts`](agent/instructions/arm.ts) | **Part 2** — per-turn warm/terse arm selection for live `eve dev`. |
| [`agent/hooks/ingest.ts`](agent/hooks/ingest.ts) | **Part 2** — ingests each `eve dev` turn into Jetty as a trajectory. |
| [`src/grade-watcher.ts`](src/grade-watcher.ts) | **Part 2** — the out-of-band grader (`npm run grade-watch`). |
| [`src/live-board.ts`](src/live-board.ts) | **Part 2** — the live scoreboard (`npm run board`). |
| [`src/feed.ts`](src/feed.ts) | **Part 2** — sends sample tickets into `eve dev` (`npm run feed`). |

The SDK does the orchestration: `runWithFiles`/`runAndWait` (with file upload),
`getTrajectory`, `downloadFile`, `addLabel`, `createTask` — plus `ingestTrajectory` and
`listTrajectories` for the Part 2 live experiment. That's the part worth copying.

## Why eve *and* Jetty?

eve ships its own evals (`defineEval`, `eve eval`, an LLM-judge, a CI gate): your unit and
integration tests, authored by the team that builds the agent and run as a deploy gate.
Jetty sits beside them: an **independent** grader the builder didn't write, and a **durable
store** where every run is a labelled trajectory you can diff across versions and models
over time. Keep `eve eval` for "did this commit break a rule"; add Jetty for "which version
is actually better, and is it improving?"

## Using `@jetty/sdk` in your own project

To use the SDK in a **new, standalone project**, install the published package from npm. No
workspaces needed:

```bash
mkdir my-app && cd my-app
npm init -y
npm pkg set type=module          # the SDK is ESM
npm install @jetty/sdk eve
```

The pattern isn't eve-specific: anywhere you can produce an agent output and call
`jetty.runAndWait(...)` on it (eve, Flue, LangChain, a raw provider SDK, a hand-rolled
loop), Jetty drops in as the eval layer. Copy the orchestration from
[`src/ab-eval.ts`](src/ab-eval.ts).

## Make it yours

- **Add cases:** append to `TICKETS` in `src/tickets.ts`.
- **Compare your own versions:** edit the two entries in `CONFIGS`, or change `EVE_MODEL`
  in `agent/agent.ts` to A/B models.
- **Move the bar:** change `PASS_BAR` in `src/eval.ts`.
- **Swap the grader:** the rubric in `grader/RUNBOOK.md` is plain Python; replace it with an
  LLM-judge call if you want model-based grading, then `npm run deploy-grader`.

## Troubleshooting

- **The harness can't reach the agent.** Start it first with `npx eve dev` (Node 24+) and
  point `EVE_URL` at it. eve's HTTP channel fails closed for non-loopback traffic; for a
  deployed agent, add an authenticator in [`agent/channels/eve.ts`](agent/channels/eve.ts).
- **`No Jetty API token found`.** You didn't load `.env`; run `set -a && . ./.env && set +a`,
  or export `JETTY_API_TOKEN`.
- **The agent didn't return JSON.** The prompt asks for a bare JSON object; `extractTriage`
  tolerates fences and prose, but tighten `agent/instructions.md` if a chatty model wanders.
- **The live run is slow.** Each grade spins up a sandbox (a few minutes for 2 tickets).
  That's expected; the offline demo (`npm run demo`) is the fast path.

> **Note on the two integrations.** Part 1 grades *through* a Jetty task — the task run is
> what creates the trajectory. Part 2 instead *pushes* each finished eve turn straight in
> with `ingestTrajectory` (`POST /api/v1/trajectories/{collection}/{name}/ingest`), the same
> endpoint behind the native `Jetty()` eve eval reporter.
