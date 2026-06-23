# Tutorial: catch a regression with `@jetty/sdk`

A step-by-step walkthrough for a developer who just checked out this repo. You'll
run an agent eval that compares two versions of a support-triage agent and tells
you which one regressed — first offline (no keys, ~10 seconds), then live.

**What you're building:** the agent (on [Flue](https://flueframework.com)) drafts
a reply; Jetty grades every draft with an independent rubric and stores each run
as a trajectory; the SDK loops over two configs and prints one verdict table.

```
TICKETS: 2   GRADER: rubric (independent)
 config        pass   avg   $/run
 v1 (warm)    2/2    4.7   0.0093  ✅
 v2 (terse)   0/2    2.7   0.0032  ❌  regressed
→ v2 (terse) is cheaper but fails the bar (4.0). Keep v1 (warm).
```

---

## 0. Prerequisites

- **Node 18+** (`node -v`).
- For the **offline** demo (Steps 1–3): **nothing** — no keys, no account.
- For the **live** run (Steps 4–7):
  - A **Jetty API token** for a collection you can write to — [jetty.io](https://jetty.io) → Settings → API Tokens.
  - An **Anthropic API key** (`sk-ant-…`) for the **local Flue agent** (it runs on your machine).
    - The **Jetty grading runs on your free trial** — *no key needed for that part* (see [Run it on Jetty's free trial](#run-it-on-jettys-free-trial)).

> **Three levels of "do I need a key?"**
> 1. **Offline demo** (`npm run demo`) — no keys at all.
> 2. **Grading on Jetty** — covered by the **free trial** (10 runs, auto-activated). No API key.
> 3. **The live Flue agent** — runs on *your* machine via Flue, so it uses your Anthropic key.

---

## 1. Clone this repo and build

> ⚠️ This tutorial runs the example **bundled in this repo**. Clone it and run
> everything from inside the checkout — the `-w @jetty/sdk` flags below refer to
> this monorepo's workspaces. **Don't `npm init` a new project** (you'd get
> `No workspaces found: --workspace=@jetty/sdk`). To use the SDK in your *own*
> app instead, skip to [Using `@jetty/sdk` in your own project](#using-jettysdk-in-your-own-project).

```bash
git clone https://github.com/jettyio/jetty-sdk.git
cd jetty-sdk
npm install                    # installs the SDK, the example, and Flue (one workspace install)
npm run build -w @jetty/sdk    # the example imports the built SDK
```

## 2. Move into the example

```bash
cd examples/flue-jetty
```

## 3. Run the offline demo (no keys)

```bash
npm run demo
```

You should see the verdict table immediately:

```
Acme Helpdesk — did my last change to the triage agent make it worse?
(simulated; run `npm run eval` for the real thing)

TICKETS: 5   GRADER: rubric (independent)

 config        pass   avg   $/run
 ------------  -----  ----  -------
 v1 (warm)    5/5    4.5   0.0051  ✅
 v2 (terse)   1/5    3.5   0.0039  ❌  regressed

→ v2 (terse) is cheaper but fails the bar (4.0). Keep v1 (warm).
```

It also writes **`report.html`** and opens it in your browser — a styled
verdict + per-run breakdown (the same report the live run produces). This is a
deterministic stand-in for the live run — same data shape, no spend. If you only
want to understand the example, you can stop here.

---

## 4. Configure credentials (for the live run)

```bash
cp .env.example .env
```

Edit `.env`:

```ini
ANTHROPIC_API_KEY=sk-ant-...          # your Anthropic key
JETTY_API_TOKEN=mlc_...               # your Jetty token
JETTY_COLLECTION=your-collection      # a collection your token can write to
JETTY_GRADE_TASK=triage-grader        # leave as-is
```

Load it into your shell (the scripts read `process.env`, they don't auto-load `.env`):

```bash
set -a && . ./.env && set +a
```

> `.env` is gitignored — don't commit it.

## 5. Deploy the grader (one time)

The workflow calls a Jetty runbook that scores each draft. Deploy it into your
collection:

```bash
npm run deploy-grader
```

Expected:

```
[env] pushed: ANTHROPIC_API_KEY
[task] created your-collection/triage-grader
✓ deployed: your-collection/triage-grader
```

This pushes your `ANTHROPIC_API_KEY` into the collection (so the grader's sandbox
can run) and creates the `triage-grader` task from [`grader/RUNBOOK.md`](grader/RUNBOOK.md).
Re-running it updates the task.

> **No Anthropic key?** Skip the push — the grader can run on Jetty's free trial
> instead. See [Run it on Jetty's free trial](#run-it-on-jettys-free-trial).

## 6. Run the live A/B

```bash
npx flue run eval --target node --input '{"tickets":2}'
```

Each ticket is a real server-side grade (a sandbox run), so start with `tickets:2`
(~a few minutes) before bumping up to the full 5. You'll see a line per run, then
the verdict table:

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

…then it writes **`report.html`** and opens it in your browser — the verdict, a
per-run breakdown, and links to each Jetty trajectory.

### Run it on Jetty's free trial

Jetty gives every collection a **free trial** (10 runs, auto-activated — no
signup step) whose model calls run on **Jetty's keys**. So you can run the
**grading** with **no Anthropic key** and no key-push:

```bash
# deploy without pushing a key (the trial covers the grader)
unset ANTHROPIC_API_KEY
npm run deploy-grader

# grade on the trial
JETTY_USE_TRIAL_KEYS=true npx flue run eval --target node --input '{"tickets":2}'
```

The trial covers **server-side Jetty runs** (the grader). The **Flue agent runs
on your machine**, so the *full* live run still needs your Anthropic key for the
agent — but you can see Jetty's grading + trajectories on the trial with zero
keys, and the `npm run demo` verdict needs no keys at all. (Trial covers Sonnet
and most models; Opus-class models are excluded. After 10 runs, add your own key
in Settings.)

That's the whole point: **the eval caught that the terse config regressed** —
before it ever reached a customer.

## 7. Inspect what got stored

Every grade is a Jetty **trajectory**, labelled with `eval.config`, `eval.grade`,
`eval.pass`, and `eval.cost_usd`. View them in the Jetty UI
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

Because the runs are durable and labelled, you can compare configs over time and
detect regressions across releases — not just in this one terminal session.

---

## How it works (the pieces)

| File | Role |
|------|------|
| [`src/tickets.ts`](src/tickets.ts) | The eval cases + the two configs (`v1` warm, `v2` terse). |
| [`src/agent.ts`](src/agent.ts) | The Flue triage agent (`triageAgent`); the config's style is injected per prompt (`triagePrompt`). |
| [`src/workflows/eval.ts`](src/workflows/eval.ts) | The `defineWorkflow` live loop: for each config × ticket → Flue draft → `gradeWithJetty` (grade + label) → collect. |
| [`src/eval.ts`](src/eval.ts) | `aggregate()` (per-config pass-rate/score/cost) + `renderVerdict()` (the table). |
| [`grader/RUNBOOK.md`](grader/RUNBOOK.md) | The independent grader — a deterministic Python rubric. |
| [`src/deploy-grader.ts`](src/deploy-grader.ts) | Deploys the grader via the SDK (`createTask` + `setEnvironmentVars`). |
| [`src/simulate.ts`](src/simulate.ts) | The deterministic stand-in behind `npm run demo`. |

The SDK does the orchestration — `runWithFiles`/`runAndWait` (with file upload),
`getTrajectory`, `downloadFile`, `addLabel`, `createTask`. That's the part worth
copying into your own eval.

## Using `@jetty/sdk` in your own project

Everything above runs the example *inside this repo*. To use the SDK in a **new,
standalone project**, you don't need this repo or any workspaces — install the
published package from npm:

```bash
mkdir my-app && cd my-app
npm init -y
npm pkg set type=module          # the SDK is ESM
npm install @jetty/sdk
```

```js
// index.js
import { JettyClient } from "@jetty/sdk";
const jetty = new JettyClient();               // reads JETTY_API_TOKEN (or ~/.config/jetty/token)
console.log((await jetty.listCollections()).map((c) => c.name));
```

```bash
JETTY_API_TOKEN=mlc_... node index.js
```

There is **no `-w @jetty/sdk` here** — that flag only applies inside this repo's
monorepo. From there, copy the orchestration pattern from
[`src/workflows/eval.ts`](src/workflows/eval.ts) into your own code.

## Make it yours

- **Add cases:** append to `TICKETS` in `src/tickets.ts`.
- **Compare your own versions:** edit the two entries in `CONFIGS` (e.g. a prompt
  you're considering vs. the current one), or change `FLUE_MODEL` to A/B models.
- **Move the bar:** change `PASS_BAR` in `src/eval.ts`.
- **Swap the grader:** the rubric in `grader/RUNBOOK.md` is plain Python — replace
  it with an LLM-judge call if you want model-based grading, then `npm run deploy-grader`.

## Troubleshooting

- **`No workspaces found: --workspace=@jetty/sdk`** — you're not inside the
  jetty-sdk checkout (e.g. you ran `npm init` in a fresh folder). The `-w` flag
  is monorepo-only: `git clone` this repo and run from its root (Step 1). To use
  the SDK in your own project instead, see
  [Using `@jetty/sdk` in your own project](#using-jettysdk-in-your-own-project).
- **`grader produced no /app/results files`** — the grader must (a) run on a model
  the claude-code runtime supports (use `claude-sonnet-4-6`, not haiku), (b) keep
  the `secrets: ANTHROPIC_API_KEY` block in its frontmatter so the key reaches the
  sandbox, and (c) write to **`/app/results/`** (the directory Jetty collects).
  All three are already set in `grader/RUNBOOK.md`.
- **`No Jetty API token found`** — you didn't load `.env`; run `set -a && . ./.env && set +a`, or export `JETTY_API_TOKEN`.
- **`Cannot use import statement outside a module`** — `flue run` needs `"type": "module"` (already set here) and `flue.config.ts` at the example root.
- **The live run is slow** — each grade spins up a sandbox (a few minutes for 2 tickets). That's expected; the offline demo (`npm run demo`) is the fast path.

> **Note on scope:** Jetty has no external trajectory-ingestion endpoint yet, so
> grading runs *through* a Jetty task (which is what creates the trajectory)
> rather than pushing an externally-produced trace. Direct ingestion is a later
> project in the SDK initiative.
