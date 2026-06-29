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

      // eve's turnId is per-session (turn_0, turn_1, …), so key on session+turn — else
      // separate chat sessions all collide on "turn_0" and overwrite each other. Same
      // (session, turn) still maps to one id, so a re-push of that turn overwrites in place.
      const trajId = `${ctx.session.id}-${turnId}`;
      try {
        const { trajectory_id } = await client.ingestTrajectory(COLLECTION, AGENT_TASK, {
          trajectory_id: trajId,
          input: ticket,
          output: triage,
          status: "completed",
          source: "eve-dev",
          author: AUTHOR,
          cost_usd: cost,
          labels: { "eval.config": arm ?? "unknown", "eval.source": "eve-dev" },
          metadata: { sessionId: ctx.session.id, turnId, arm: arm ?? "unknown" },
        });
        console.log(
          `[ingest-hook] ${arm ?? "?"} turn → ${COLLECTION}/${AGENT_TASK} (${trajectory_id}) — ungraded`,
        );
      } catch (err) {
        console.warn(`[ingest-hook] ingest failed (chat unaffected): ${msg(err)}`);
      }
    },
  },
});
