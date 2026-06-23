# Catch a regression before you ship: agent eval with Jetty

AI agents need to be regularly evaluated and tested since they depend on models, context and usage. The next step is checking to see if a new model, harness or instruction improves either the quality or the cost of your agent. With Jetty, you can easily test an agent runbook and answer **is the agent improving?**

This example makes it visible: run two versions of an agent over a set
of cases, have **an independent grader score each**, and get one table that tells
you which version regressed. It's the *run, check, fix, rerun* loop from
[_How to build an AI agent_](https://jetty.io/guides/how-to-build-an-ai-agent),
with the check wired in.

The agent runs on **[Flue](https://flueframework.com)** and then **Jetty** grades every
run and stores it. **`@jetty/sdk`** orchestrates the comparison.

```
TICKETS: 5   GRADER: rubric (independent)

 config        pass   avg   $/run
 ------------  -----  ----  -------
 v1 (warm)    5/5    4.5   0.0051  ✅
 v2 (terse)   1/5    3.5   0.0039  ❌  regressed

→ v2 (terse) is cheaper but fails the bar (4.0). Keep v1 (warm).
```

Every row is a Jetty [trajectory](https://docs.jetty.io), scored by a grader the
agent didn't write and labelled with `config`, `score`, and `cost`. The
comparison is durable and queryable, not a number that scrolls off your terminal.

> **Following along from a fresh checkout?** [`TUTORIAL.md`](TUTORIAL.md) walks
> through every step (offline demo → creds → deploy grader → live A/B → inspect).

## See it now (offline, no keys)

```bash
# from the repo root
npm install
npm run build -w @jetty/sdk

cd examples/flue-jetty && npm run demo
```

That prints the verdict table above from a deterministic stand-in. Same shape the
live run produces, no spend.

## Run it for real

The agent (`claude-sonnet-4-6`) drafts. An **independent rubric** grades each
draft: a Jetty runbook running a deterministic Python scorer, reproducible and
not written by the agent. Swap in an LLM judge by editing `grader/RUNBOOK.md`.

```bash
cp .env.example .env && set -a && . ./.env && set +a   # ANTHROPIC + Jetty creds

# 1. Deploy the grader once (a Jetty runbook that scores a triage).
npm run deploy-grader

# 2. A/B-eval the agent. Each ticket is a real server-side grade, so start small.
npx flue run eval --target node --input '{"tickets":2}'
```

You'll see a `config · ticket: score PASS/fail` line per run, the verdict table,
and then a styled **`report.html`** opens in your browser (verdict, per-run
breakdown, trajectory links).

**No Anthropic key?** The grading runs on Jetty's **free trial** (10 runs,
auto-activated). Deploy without a key and run with `JETTY_USE_TRIAL_KEYS=true`.
The local Flue agent still needs your key; the offline `npm run demo` needs none.
See [`TUTORIAL.md`](TUTORIAL.md#run-it-on-jettys-free-trial).

## Why Jetty here

The agent writes the reply. **Jetty is the judge and the memory.** ([Why a check
beats a dashboard](https://blog.jetty.io).)

- **An independent grader.** Grading is a separate Jetty runbook (here a
  deterministic rubric; swap in an LLM judge if you prefer). It isn't the agent
  scoring itself, which rubber-stamps. Change the rubric without redeploying the
  agent; every config reuses it.
- **Every run is a trajectory.** Durable, replayable, labelled with score and
  cost. That's what lets you compare configs and catch a regression. A stream of
  events you can't query can't do either.
- **Quality next to cost.** The table puts pass-rate, score, and `$/run` in one
  view, so "cheaper but worse" is obvious at a glance.

> **Today's limit:** Jetty has no external trajectory-ingestion endpoint yet, so
> this grades through a Jetty task (which creates the trajectory) rather than
> pushing an externally-produced trace. That ingestion endpoint is a later
> project in the SDK initiative.

## Files

| Path | What it is |
|------|------------|
| `src/tickets.ts` | The eval cases plus the two agent configs (warm vs terse). |
| `src/agent.ts` | The Flue triage agent (parameterized by config). |
| `src/eval.ts` | `aggregate()` + `renderVerdict()`: the scoring and the table. |
| `src/simulate.ts` | Deterministic stand-in for the offline demo. |
| `src/demo-offline.ts` | `npm run demo`, the no-keys verdict table. |
| `src/workflows/eval.ts` | `npm run eval`, the live A/B over Flue + Jetty. |
| `src/deploy-grader.ts` + `grader/RUNBOOK.md` | The server-side judge and its deploy. |
| `src/report.ts` | Renders the ds01-styled `report.html` the runs open. |

## Docs

- [`TUTORIAL.md`](TUTORIAL.md): step-by-step from a fresh checkout.
- [`ECOSYSTEM-QUICKSTART.md`](ECOSYSTEM-QUICKSTART.md): the Flue-ecosystem integration guide (Quickstart · Overview · Configure · What Jetty captures · Verify).
- [How to build an AI agent](https://jetty.io/guides/how-to-build-an-ai-agent) · [docs](https://docs.jetty.io) · [blog](https://blog.jetty.io)
