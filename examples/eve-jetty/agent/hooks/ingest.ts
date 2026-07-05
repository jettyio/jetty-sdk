/**
 * Live ingest hook: push every `eve dev` turn into Jetty as a trajectory.
 *
 * Runs server-side in the `eve dev` process. eve has no single "turn finished,
 * here's the text + token usage" callback — `turn.completed` carries only a
 * turnId. So we accumulate across the turn's stream events and flush on completion:
 *   - message.received  → the user's ticket text
 *   - message.completed → the assistant's triage JSON
 *   - step.completed    → token usage (eve reports tokens, not dollars)
 * On turn.completed we parse the triage, estimate cost, read back which arm this
 * turn ran (from agent/instructions/arm.ts), and ingest an UNGRADED trajectory.
 * The out-of-band grader (src/grade-watcher.ts) scores it a beat later and writes
 * the grade back onto THIS trajectory — grading never blocks the chat.
 *
 * Best-effort by design: a thrown hook becomes `turn.failed` in eve, so every
 * side effect is wrapped. With no JETTY_COLLECTION set the hook no-ops and the
 * chat is unaffected, so the agent dir is safe to run without Jetty.
 */
import { defineHook } from "eve/hooks";
import { JettyClient } from "@jetty/sdk";

// Shared with agent/instructions/arm.ts via globalThis: eve may load the resolver
// and this hook as separate bundles, so a plain `import` isn't guaranteed to be the
// same Map. The global key is the single source of truth for which arm each turn ran.
const armForTurn = ((globalThis as Record<string, unknown>).__eveJettyArmForTurn ??=
  new Map<string, string>()) as Map<string, string>;

const COLLECTION = process.env.JETTY_COLLECTION ?? "";
const AGENT_TASK = process.env.JETTY_AGENT_TASK ?? "triage-live";
const AUTHOR = process.env.JETTY_AUTHOR ?? "eve-dev@acme.example";
const MODEL = process.env.EVE_MODEL ?? "anthropic/claude-sonnet-4.6";
// "ingest" (default): write a finished trajectory; the out-of-band grade-watcher scores it.
// "simple_judge": run the native Jetty simple_judge task on triage-live and label its score
// here — no grade-watcher, no sandbox. Both end with the same eval.* labels on the run.
const JUDGE_MODE = process.env.JUDGE_MODE ?? "ingest";

// Illustrative $/1M tokens (mirrors src/cost.ts). Tune to your real rates.
const PRICES: Record<string, { in: number; out: number }> = {
  "anthropic/claude-sonnet-4.6": { in: 3, out: 15 },
  "anthropic/claude-opus-4.8": { in: 15, out: 75 },
};
const price = PRICES[MODEL] ?? { in: 3, out: 15 };

interface Turn {
  input?: string;
  reply?: string;
  inTok: number;
  outTok: number;
}
const turns = new Map<string, Turn>();
const turn = (turnId: string): Turn => {
  let t = turns.get(turnId);
  if (!t) {
    t = { inTok: 0, outTok: 0 };
    turns.set(turnId, t);
  }
  return t;
};

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

let client: JettyClient | undefined;
let disabled = false;
if (!COLLECTION) {
  disabled = true;
  console.warn("[ingest-hook] JETTY_COLLECTION unset — live ingest disabled (chat still works).");
} else {
  try {
    client = new JettyClient();
  } catch (err) {
    disabled = true;
    console.warn(`[ingest-hook] could not construct JettyClient; live ingest disabled: ${msg(err)}`);
  }
}

/** Pull the first {...} JSON object out of model text (tolerates fences/prose). */
function extractTriage(text: string): { category?: string; priority?: number; draft_reply?: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) return {};
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return {};
  }
}

interface Triage {
  category?: string;
  priority?: number;
  draft_reply?: string;
}

/** The judge's full verdict, parsed out of simple_judge's raw_result JSON. */
interface JudgeVerdict {
  score?: number;
  explanation?: string;
  dimensions?: Record<string, number>;
  policy_violation?: boolean;
}

/** Parse the judge's raw_result (tolerates fences/prose around the JSON). */
function parseVerdict(raw: unknown): JudgeVerdict {
  if (typeof raw !== "string") return {};
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end < start) return {};
  try {
    return JSON.parse(raw.slice(start, end + 1)) as JudgeVerdict;
  } catch {
    return {};
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * addLabel with retry. A grade a human never sees is a grade that didn't happen —
 * one dropped POST used to leave a judged run permanently unlabeled on the board,
 * so each label gets three attempts with backoff before we give up and log.
 */
async function addLabelSafe(
  client: JettyClient,
  id: string,
  key: string,
  value: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await client.addLabel(COLLECTION, AGENT_TASK, id, key, value, AUTHOR);
      return;
    } catch (err) {
      if (attempt === 3) {
        console.warn(`[ingest-hook] label ${key}=${value} failed after 3 tries: ${msg(err)}`);
        return;
      }
      await sleep(400 * attempt);
    }
  }
}

/**
 * Write the labels, then verify they stuck and re-write any that didn't.
 *
 * Labels POSTed in the first moments after a run reaches `completed` can be lost
 * server-side: mise's own final trajectory write races the label write and clobbers
 * it (observed as runs missing exactly the FIRST label written, with a 200 on every
 * POST — retries can't help because the client never sees a failure). So: settle,
 * write, read back, repair.
 */
async function writeLabelsVerified(
  client: JettyClient,
  id: string,
  labels: Array<[string, string]>,
): Promise<void> {
  await sleep(1500); // let the server's final trajectory write land first
  for (const [k, v] of labels) await addLabelSafe(client, id, k, v);
  await sleep(1200);
  try {
    const traj = await client.getTrajectory(COLLECTION, AGENT_TASK, id);
    const present = new Set((traj.labels ?? []).map((l) => l.key));
    const missing = labels.filter(([k]) => !present.has(k));
    for (const [k, v] of missing) {
      console.warn(`[ingest-hook] label ${k} lost server-side on ${id} — re-writing`);
      await addLabelSafe(client, id, k, v);
    }
  } catch (err) {
    console.warn(`[ingest-hook] label verify on ${id} skipped: ${msg(err)}`);
  }
}

/**
 * JUDGE_MODE="simple_judge": run the native Jetty `simple_judge` task on triage-live
 * for this turn (one LLM call, no sandbox), then promote its score — a step output —
 * to `eval.*` labels so the board and spot's Labels panel show it unchanged. Replaces
 * the out-of-band grade-watcher: grading happens inside the Jetty run.
 */
async function runJudge(
  client: JettyClient,
  ticket: { subject: string; body: string },
  triage: Triage,
  arm: string,
  cost: number,
): Promise<void> {
  const item =
    `TICKET:\n${ticket.subject}\n${ticket.body}\n\n` +
    `TRIAGE RESPONSE:\ncategory: ${triage.category ?? ""}\n` +
    `priority: ${triage.priority ?? ""}\ndraft_reply: ${triage.draft_reply ?? ""}`;

  // runAndWait returns the completed judge trajectory; the chat reply already streamed,
  // so this only delays the turn's idle event by the (sandbox-free) judge call.
  const traj = await client.runAndWait(
    COLLECTION,
    AGENT_TASK,
    { item, input: ticket },
    { pollMs: 2000, timeoutMs: 120_000 },
  );

  const out = (traj.steps?.judge?.outputs ?? {}) as Record<string, unknown>;
  const results = out.results as Array<{ score?: number; raw_result?: string }> | undefined;
  const score = Number(out.average_score ?? results?.[0]?.score);
  const ok = Number.isFinite(score);
  const verdict = parseVerdict(results?.[0]?.raw_result);
  const violation = verdict.policy_violation === true;
  // The 4.0 bar, plus a hard policy floor: a reply that overpromises never passes,
  // however warm it reads. (The rubric already caps the score, but the floor makes
  // the gate independent of the judge honouring that instruction.)
  const pass = ok && score >= 4.0 && !violation;
  const id = traj.trajectory_id;

  const labels: Array<[string, string]> = [
    ["eval.config", arm],
    ["eval.grade", ok ? score.toFixed(2) : "n/a"],
    ["eval.pass", String(pass)],
    ["eval.source", "eve-dev"],
    ["cost_est_usd", cost.toFixed(6)],
  ];
  for (const [dim, v] of Object.entries(verdict.dimensions ?? {})) {
    if (Number.isFinite(Number(v))) labels.push([`eval.dim.${dim}`, Number(v).toFixed(1)]);
  }
  if (verdict.policy_violation != null) {
    labels.push(["eval.policy_violation", String(violation)]);
  }
  await writeLabelsVerified(client, id, labels);
  console.log(
    `[ingest-hook] ${arm} turn → judged ${id}: ${ok ? score.toFixed(1) : "?"} ` +
      `${pass ? "PASS" : "fail"}${violation ? " ⚠ policy" : ""}`,
  );
}

export default defineHook({
  events: {
    "message.received"(event) {
      turn(event.data.turnId).input = event.data.message;
    },
    "step.completed"(event) {
      const t = turn(event.data.turnId);
      t.inTok += event.data.usage?.inputTokens ?? 0;
      t.outTok += event.data.usage?.outputTokens ?? 0;
    },
    "message.completed"(event) {
      if (event.data.message) turn(event.data.turnId).reply = event.data.message;
    },
    async "turn.completed"(event, ctx) {
      const turnId = event.data.turnId;
      const t = turns.get(turnId);
      turns.delete(turnId);
      const arm = armForTurn.get(turnId);
      armForTurn.delete(turnId);
      if (disabled || !client || !t?.reply) return;

      const triage = extractTriage(t.reply);
      const body = t.input ?? "";
      const ticket = {
        id: turnId.slice(0, 8),
        subject: body.split("\n")[0]?.slice(0, 80) ?? "",
        body,
        tier: "unknown",
      };
      const cost = (t.inTok / 1e6) * price.in + (t.outTok / 1e6) * price.out;
      const armName = arm ?? "unknown";

      try {
        if (JUDGE_MODE === "simple_judge") {
          await runJudge(client, ticket, triage, armName, cost);
        } else {
          // eve's turnId is per-session (turn_0, turn_1, …), so key on session+turn — else
          // separate chat sessions all collide on "turn_0" and overwrite each other.
          const trajId = `${ctx.session.id}-${turnId}`;
          const { trajectory_id } = await client.ingestTrajectory(COLLECTION, AGENT_TASK, {
            trajectory_id: trajId,
            input: ticket,
            output: triage,
            status: "completed",
            source: "eve-dev",
            author: AUTHOR,
            cost_usd: cost,
            labels: { "eval.config": armName, "eval.source": "eve-dev" },
            metadata: { sessionId: ctx.session.id, turnId, arm: armName },
          });
          console.log(
            `[ingest-hook] ${armName} turn → ${COLLECTION}/${AGENT_TASK} (${trajectory_id}) — ungraded`,
          );
        }
      } catch (err) {
        console.warn(`[ingest-hook] ${JUDGE_MODE} failed (chat unaffected): ${msg(err)}`);
      }
    },
  },
});
