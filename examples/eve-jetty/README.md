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

> **Following along from a fresh checkout?** [`TUTORIAL.md`](TUTORIAL.md) walks through
> every step (offline demo → creds → deploy grader → live A/B → inspect).

## eve already has evals. Why add Jetty?

eve ships a real eval system (`defineEval`, `eve eval`, an LLM-as-judge, a CI deploy
gate). Those are your **unit and integration tests**: you author the assertions, they
run your scripted sessions, they gate a deploy. Jetty sits beside them:

- **An independent grader.** A runbook the agent under test never sees, so the team that
  built the agent never grades its own work.
- **A durable, comparable store.** Every run is a labelled trajectory you can diff across
  versions, models, and many agents, long after the CI job ended.

Keep `eve eval` for "did this commit break a rule." Add Jetty for "which of these two
versions is better, and is it improving." The native
[`Jetty()` eval reporter](#native-reporter-coming-next) is the tighter, in-`eve eval`
integration; it's described below.

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

> **Today's limit:** Jetty has no external trajectory-ingestion endpoint yet, so this
> grades through a Jetty task (which creates the trajectory) rather than pushing an
> externally-produced trace. That ingestion endpoint is a later project in the SDK
> initiative, and the unlock for the native eve reporter below.

## Native reporter (coming next)

The most eve-idiomatic integration is a **`Jetty()` eval reporter** that drops into
`evals.config.ts` exactly where eve's built-in `Braintrust(...)` reporter goes, so every
`eve eval` result lands in Jetty as a durable, labelled trajectory:

```ts
// evals/evals.config.ts (Phase 2)
import { defineEvalConfig } from "eve/evals";
import { Jetty } from "@jetty/eve";      // implements eve's EvalReporter

export default defineEvalConfig({
  reporters: [Jetty({ collection: "acme", project: "triage-agent" })],
});
```

That ships once the trajectory-ingestion endpoint lands. The A/B harness in this example
(`src/ab-eval.ts`) works **today** and needs no eve or backend changes.

## Files

| Path | What it is |
|------|------------|
| `agent/instructions.md` | The eve agent's always-on system prompt (the JSON contract). |
| `agent/agent.ts` | The eve agent's runtime config (`defineAgent`). |
| `agent/channels/eve.ts` | The HTTP channel the harness drives (auth config). |
| `src/tickets.ts` | The eval cases plus the two agent configs (warm vs terse). |
| `src/agent-prompt.ts` | Builds the per-config message and parses the triage JSON back out. |
| `src/ab-eval.ts` | `npm run ab-eval`, the live A/B over eve + Jetty. |
| `src/cost.ts` | Estimates per-run cost from eve token usage (eve has no cost field). |
| `src/eval.ts` | `aggregate()` + `renderVerdict()`: the scoring and the table. |
| `src/simulate.ts` + `src/demo-offline.ts` | `npm run demo`, the no-keys verdict table. |
| `src/deploy-grader.ts` + `grader/RUNBOOK.md` | The server-side judge and its deploy. |
| `src/report.ts` | Renders the ds01-styled `report.html` the runs open. |

## Docs

- [`TUTORIAL.md`](TUTORIAL.md): step-by-step from a fresh checkout.
- [`ECOSYSTEM-QUICKSTART.md`](ECOSYSTEM-QUICKSTART.md): the eve-ecosystem integration guide.
- [How to build an AI agent](https://jetty.io/guides/how-to-build-an-ai-agent) · [docs](https://docs.jetty.io) · [blog](https://blog.jetty.io)
