# Catch a regression before you ship: eve agent eval with Jetty

You changed a prompt, a model, or an instruction. Did the agent get better or worse?
One reply won't tell you. This example runs two versions of a support-triage agent over
the same cases, has an independent grader score each, and prints one table that says
which version regressed. It's the *run, check, fix, rerun* loop from
[_How to build an AI agent_](https://jetty.io/guides/how-to-build-an-ai-agent), with the
check wired in.

The agent runs on **[eve](https://vercel.com/docs/eve)**, Vercel's filesystem-first
framework where an agent is a directory of files. **Jetty** grades every run and stores
it, and **`@jetty/sdk`** orchestrates the comparison.

**In the video: an eve agent that A/B-tests itself, live.** One eve agent, three reply styles —
**warm** (friendly and detailed), **terse** (one blunt line), and **balanced** (short but caring).
We don't know which one serves customers best, so instead of choosing by hand, the agent tries all
three and lets the grades decide:

[![eve × Jetty online bandit demo](media/jetty-eve-demo.gif)](media/jetty-eve-demo.mp4)

▶️ Autoplays above — click for the [full-resolution video](media/jetty-eve-demo.mp4), or see
[`DEMO.md`](DEMO.md) to run it yourself.

**How it works, in plain terms:**

1. **The eve agent answers a support ticket** in one of the three styles (it picks the style itself,
   per turn).
2. **Jetty grades that reply 1–5** with an independent rubric the agent never sees, and stores the run.
3. **A "bandit" shifts traffic toward what's working.** A [multi-armed bandit](https://en.wikipedia.org/wiki/Multi-armed_bandit)
   treats each style as a slot-machine arm: it keeps "pulling" the arms that score well and eases off
   the ones that don't. So as grades arrive, more and more replies use the leading style —
   automatically, with no manual tuning.
4. **A "release gate" calls it.** Once every style has enough graded runs, the gate marks one to
   **ship** and **blocks** the rest — and a reply that breaks policy (e.g. promising a refund it can't)
   is blocked no matter how nice it reads.

The whole loop runs online — **answer → grade → traffic shifts → gate decides** — with no human in
the middle. eve runs the agent; **Jetty is the independent grader, the durable store, and the live
reward signal that closes the loop.**

```
TICKETS: 5   GRADER: rubric (independent)

 config        pass   avg   $/run
 ------------  -----  ----  -------
 v1 (warm)    5/5    4.5   0.0051  ✅
 v2 (terse)   1/5    3.5   0.0039  ❌  regressed

→ v2 (terse) is cheaper but fails the bar (4.0). Keep v1 (warm).
```

Every row is a Jetty [trajectory](https://docs.jetty.io), scored by a grader the agent
didn't write and labelled with `config`, `grade`, and `cost`. The comparison is durable
and queryable, not a number that scrolls off your terminal.

> **Just want to see it live?** One command runs the whole thing — agent, judge, and the
> real-time dashboard, off a single `.env`: **`npm start`**. See **[`DEMO.md`](DEMO.md)** to
> get spun up with a Jetty token and a model key. (Or **[`TUTORIAL.md`](TUTORIAL.md)** for
> the step-by-step from a fresh checkout: offline demo → creds → deploy grader → live A/B.)

## eve already has evals. Why add Jetty?

eve ships a real eval system (`defineEval`, `eve eval`, an LLM-as-judge, a CI deploy
gate). Those are your **unit and integration tests**: you author the assertions, they
run your scripted sessions, they gate a deploy. Jetty sits beside them:

- **An independent grader.** A runbook the agent under test never sees, so the team that
  built the agent never grades its own work.
- **A durable, comparable store.** Every run is a labelled trajectory you can diff across
  versions, models, and many agents, long after the CI job ended.

Keep `eve eval` for "did this commit break a rule." Add Jetty for "which of these two
versions is better, and is it improving." There are two ways to wire it in, both
OpenTelemetry-free:

1. **The native [`Jetty()` eval reporter](#native-jetty-reporter)** — drops into
   `evals.config.ts` where eve's `Braintrust(...)` goes; every `eve eval` result lands in
   Jetty as a durable trajectory.
2. **The [external A/B harness](#run-it-for-real)** (`src/ab-eval.ts`) — drives the agent
   over `eve/client` and grades each run with an independent Jetty rubric.

## See it now (offline, no keys)

```bash
# from the repo root
npm install
npm run build -w @jetty/sdk

cd examples/eve-jetty && npm run demo
```

That prints the verdict table above from a deterministic stand-in. Same shape the live
run produces, with no keys, no network, and no spend.

## Run it for real

The agent (`anthropic/claude-sonnet-4.6`, via eve + AI Gateway) drafts. An **independent
rubric** grades each draft: a Jetty runbook running a deterministic Python scorer,
reproducible and not written by the agent. Swap in an LLM judge by editing
`grader/RUNBOOK.md`.

```bash
cp .env.example .env && set -a && . ./.env && set +a   # AI Gateway + Jetty creds

# 1. Deploy the grader once (a Jetty runbook that scores a triage).
npm run deploy-grader

# 2. In one terminal, serve the eve agent:
npx eve dev                                            # http://127.0.0.1:2000

# 3. In another, A/B-eval it. Each ticket is a real server-side grade, so start small.
EVAL_TICKETS=2 npm run ab-eval
```

You'll see a `config · ticket: score PASS/fail` line per run, the verdict table, and
then a styled **`report.html`** opens in your browser (verdict, per-run breakdown,
trajectory links).

**No provider key?** The grading runs on Jetty's **free trial** (10 runs,
auto-activated). Deploy without a key and run with `JETTY_USE_TRIAL_KEYS=true`. The local
eve agent still needs a model credential: an AI Gateway key, or set `OPENROUTER_API_KEY`
so `agent/agent.ts` routes it through OpenRouter directly. The offline `npm run demo`
needs none.

## Part 2: the live online experiment (watch Jetty grade as you type)

The A/B above is a *controlled batch* — it runs both configs over the same tickets and
grades each inline. The other way teams actually run an experiment is **online**: one
agent randomizes its own behaviour per request, every run is logged, and grading happens
**out of band** so it never sits in the request path. This example ships that shape too,
and it's built to demo live.

```bash
cp .env.example .env && set -a && . ./.env && set +a
npm run deploy-grader            # once — the same independent grader as Part 1

# then three terminals:
npx eve dev                      # 1. the agent — randomizes warm/terse per turn
npm run grade-watch              # 2. the out-of-band grader
npm run board                    # 3. the live scoreboard → http://localhost:4500
```

Type a support ticket into the `eve dev` chat. What happens:

1. **The agent picks an arm — and it's not a coin flip.** A per-turn dynamic-instructions
   resolver (`agent/instructions/arm.ts`) runs a **Thompson-sampling bandit whose reward
   signal is the live pass-rate read back from Jetty labels**. It explores 50/50 until each
   arm has `BANDIT_MIN_PER_ARM` judged runs (matched to the monitor's release gate), then
   routes traffic toward the winning arm. Grades steer the agent: Jetty isn't a scoreboard
   here, it's the reward signal. (`JETTY_BANDIT=off` restores the fair coin for a
   controlled experiment.)
2. **The run lands in Jetty immediately**, via a hook (`agent/hooks/ingest.ts`) that
   ingests the finished turn as a trajectory tagged `eval.config=warm|terse`, still
   ungraded.
3. **The grader scores it a beat later.** `grade-watch` finds ungraded runs, scores each
   with the *independent* Jetty grader, and writes `eval.grade` / `eval.pass` back onto
   the run — decoupled from the chat, so the agent never waits on grading.
4. **The board lights up.** Each run appears as a row that flips from "grading…" to a
   green pass or red fail, and the arms' pass-rates diverge in front of the room.

No one to type for you? `npm run feed` sends the sample tickets in as if typed
(`FEED_ROUNDS=2` to loop them and let the bandit converge on stage). The rotation
includes a **policy-trap ticket** (`src/tickets.ts` → `TRAP_TICKETS`): a customer
demanding "confirm my refund is processed RIGHT NOW." A warm agent that capitulates
scores high on empathy and gets flagged `policy_violation` by the judge — the moment
that shows why the grader must be independent: self-graded agents rubber-stamp exactly
this.

> **Why a separate board?** The real Jetty UI is a durable store, not a live ticker — its
> run list polls slowly and doesn't surface labels inline, so grades wouldn't visibly
> "light up." `npm run board` is a 2-second-poll view built for the demo; the
> trajectories it reads are the same durable records you can query later.

> **Part 1 vs Part 2.** Part 1 is the clean, repeatable regression check (paired,
> deterministic). Part 2 is the production-shaped online experiment (randomized, graded
> async). Same agent, same independent grader — a different question.

### Part 2b: grade with a native `simple_judge` (no grade-watcher)

Don't want to run a watcher or a sandbox? Set **`JUDGE_MODE=simple_judge`** and `triage-live`
becomes a real Jetty task whose workflow is a single **`simple_judge`** step (LLM-as-judge).
The eve hook runs it per turn and labels the score itself — so you drop `grade-watch` entirely.

```bash
npm run deploy-judge                    # make triage-live a simple_judge task (once)
JUDGE_MODE=simple_judge npx eve dev     # terminal 1
npm run board                           # terminal 2 — that's it, no grade-watch
```

Same labels (`eval.config` / `eval.grade` / `eval.pass` / `cost_est_usd`) and the same board;
the grade is now produced by a native Jetty step (no sandbox) and each run also carries a
written `explanation`. The rubric is **multi-dimensional**: the judge returns per-dimension
scores (`empathy` / `actionability` / `accuracy` / `policy`) plus a `policy_violation` flag,
which the hook writes back as `eval.dim.*` / `eval.policy_violation` labels — a run that
overpromises never passes, however warm it reads (a hard policy floor in the hook, on top of
the rubric's score cap). Edit the rubric in plain English in `src/deploy-judge.ts`, redeploy,
then `npm run judge-smoke` to sanity-check the verdict shape on a canned violating triage.
Trade-off: it's an LLM judge, not the deterministic Python rubric — more flexible, less
reproducible.

### The demo arc (three terminals + the conference monitor)

The conference monitor (`npm run monitor`, folded into this example at
[`monitor/`](monitor/)) renders the whole story: per-dimension verdict bars, the bandit's
traffic-allocation shifting live, a **release gate** that flips to SHIP/BLOCK once each arm
has `GATE_MIN_RUNS` judged runs (optionally posting a one-shot Slack alert), a pass-rate
trend + cost-vs-quality history strip, and a deep link from every card to the same
trajectory in the Jetty UI. It reads the same `.env` as everything else, so the agent and
the monitor watch the same collection/task and arm the gate at the same count with no extra
config.

```bash
cp .env.example .env && set -a && . ./.env && set +a   # one .env for every terminal
npm run deploy-judge                          # once
JUDGE_MODE=simple_judge npx eve dev           # terminal 1 — agent + bandit + judge
npm run monitor                               # terminal 2 — http://localhost:4600
                                              #   (set SLACK_ALERT_CHANNEL in .env for the alert)
FEED_ROUNDS=2 npm run feed                    # terminal 3 — or let the room type
```

Stage arc: runs stream in while the bandit explores all three arms (warm / terse /
balanced) → a trap ticket gets a warm reply flagged **⚠ POLICY** → at 5 judged runs per
arm the gate **ships the winner and blocks the weaker arms** (a Slack alert fires per
blocked arm) → the allocation bar converges on whichever arm the grades favor. Measurement
→ decision → action, all driven by Jetty grades.

## Why Jetty here

The agent writes the reply. **Jetty is the judge and the memory.** ([Why a check beats a
dashboard](https://blog.jetty.io).)

- **An independent grader.** Grading is a separate Jetty runbook (here a deterministic
  rubric; swap in an LLM judge if you prefer). It isn't the agent scoring itself, which
  rubber-stamps. Change the rubric without redeploying the agent; every config reuses it.
- **Every run is a trajectory.** Durable, replayable, labelled with grade and cost. That's
  what lets you compare configs and catch a regression. A stream of events you can't query
  can't do either.
- **Quality next to cost.** The table puts pass-rate, grade, and `$/run` in one view, so
  "cheaper but worse" is obvious at a glance.

> **A note on cost.** Flue handed us a dollar cost per run directly. eve reports token
> usage on its `step.completed` events but no dollar figure, so this example *estimates*
> cost from tokens and a small per-model price table (`src/cost.ts`) and labels it
> `eval.cost_est_usd`. Tune the prices to your real rates.

> **Two complementary integrations.** The A/B harness above grades through a Jetty task
> (Jetty *runs* the rubric, which creates the trajectory) — Jetty as the independent
> *grader*. The native reporter below instead *pushes* eve's own finished eval results
> into Jetty via the trajectory-ingestion endpoint — Jetty as the durable *scoreboard*.
> Use either or both.

## Native `Jetty()` reporter

The most eve-idiomatic integration is a **`Jetty()` eval reporter** that drops into
`evals.config.ts` exactly where eve's built-in `Braintrust(...)` reporter goes, so every
`eve eval` result lands in Jetty as a durable, labelled trajectory. This example ships it
in [`src/jetty-reporter.ts`](src/jetty-reporter.ts) (it implements eve's `EvalReporter`):

```ts
// evals/evals.config.ts
import { defineEvalConfig } from "eve/evals";
import { Jetty } from "../src/jetty-reporter.js";   // implements eve's EvalReporter

export default defineEvalConfig({
  reporters: [Jetty()],   // collection/project from JETTY_COLLECTION / JETTY_PROJECT
});
```

Run it:

```bash
npx eve dev                                               # terminal A: serve the agent
JETTY_COLLECTION=acme JETTY_PROJECT=triage-agent npx eve eval   # terminal B
```

Each result is pushed with one `ingestTrajectory` call (`scores` → `score.<name>` labels,
verdict + status as labels). Point at a local mise with `JETTY_API_URL=http://localhost:8000`.
The reporter never fails a run: if Jetty is unreachable it logs a warning and `eve eval`
continues. With no `JETTY_COLLECTION` set it no-ops, so `evals/` is safe to commit.

> Needs the mise trajectory-ingestion endpoint
> (`POST /api/v1/trajectories/{collection}/{name}/ingest`). It graduates into a standalone
> `@jetty/eve` package later; here it lives in the example so you can read and run it.

## Files

| Path | What it is |
|------|------------|
| `start.mjs` | `npm start`, the one-command launcher: validates `.env`, deploys the judge, runs the agent + monitor together, clean Ctrl-C. See [`DEMO.md`](DEMO.md). |
| `agent/instructions.md` | The eve agent's always-on system prompt (the JSON contract). |
| `agent/agent.ts` | The eve agent's runtime config (`defineAgent`). |
| `agent/channels/eve.ts` | The HTTP channel the harness drives (auth config). |
| `src/tickets.ts` | The Part 1 eval cases + the two batch configs (warm/terse), plus the live-only tickets and policy-trap tickets the feeder sends (3× the rotation). |
| `src/agent-prompt.ts` | Builds the per-config message and parses the triage JSON back out. |
| `evals/evals.config.ts` | Wires the native `Jetty()` reporter into `eve eval`. |
| `evals/triage.eval.ts` | A native eve eval; its result is reported to Jetty. |
| `src/jetty-reporter.ts` | The `Jetty()` eve `EvalReporter` (pushes results via `ingestTrajectory`). |
| `src/ab-eval.ts` | `npm run ab-eval`, the live A/B over eve + Jetty (Part 1). |
| `agent/instructions/arm.ts` | Part 2 — episodic arm selection for live `eve dev`: a Thompson bandit over three arms (warm / terse / balanced) that commits one arm per episode, rewarded by live Jetty pass-rates (dynamic instructions). |
| `agent/hooks/ingest.ts` | Part 2 — live ingest hook; pushes each `eve dev` turn into Jetty as a trajectory (and in judge mode, labels grade + dimensions + policy). |
| `src/grade-watcher.ts` | Part 2 — `npm run grade-watch`, the out-of-band grader: scores ungraded runs, labels them. |
| `src/deploy-judge.ts` | Part 2b — `npm run deploy-judge`, makes `triage-live` a native `simple_judge` task with the multi-dimension rubric (`JUDGE_MODE=simple_judge`, no grade-watcher). |
| `src/judge-smoke.ts` | Part 2b — `npm run judge-smoke`, demo-prep sanity check: judges a canned policy-violating triage, asserts the verdict shape. |
| `src/live-board.ts` | Part 2 — `npm run board`, the simple zero-config scoreboard that lights up as grades land. |
| `monitor/` | Part 2 — `npm run monitor`, the full conference dashboard (verdict bars, bandit allocation, release gate + Slack alert, history strip). Zero-dep Node; reads the shared `.env`. |
| `monitor-vercel/` | The dashboard as a one-click Vercel deploy: static page + a stateless `/api/runs` function (client polls instead of SSE). See [`DEMO.md`](DEMO.md#deploy-it-to-vercel-end-to-end). |
| `src/feed.ts` | Part 2 — `npm run feed`, sends the sample tickets into `eve dev` (rehearsal). |
| `src/cost.ts` | Estimates per-run cost from eve token usage (eve has no cost field). |
| `src/eval.ts` | `aggregate()` + `renderVerdict()`: the scoring and the table. |
| `src/simulate.ts` + `src/demo-offline.ts` | `npm run demo`, the no-keys verdict table. |
| `src/deploy-grader.ts` + `grader/RUNBOOK.md` | The server-side judge and its deploy. |
| `src/report.ts` | Renders the ds01-styled `report.html` the runs open. |

## Docs

- [`TUTORIAL.md`](TUTORIAL.md): step-by-step from a fresh checkout.
- [`ECOSYSTEM-QUICKSTART.md`](ECOSYSTEM-QUICKSTART.md): the eve-ecosystem integration guide.
- [How to build an AI agent](https://jetty.io/guides/how-to-build-an-ai-agent) · [docs](https://docs.jetty.io) · [blog](https://blog.jetty.io)
