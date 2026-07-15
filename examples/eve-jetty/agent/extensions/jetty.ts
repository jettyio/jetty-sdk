/**
 * Mount the @jetty/eve extension — this one file is the whole Jetty integration.
 *
 * The file name is the namespace: the extension's contributions compose into
 * this agent as `jetty__…` (its ingest hook, its bandit arm resolver, and the
 * `jetty__experiment` tool the model can call). Config binds HERE, once, from
 * the same env vars every other terminal reads — the agent-side counterpart of
 * .env.example's Part 2 knobs. Everything that used to live in
 * agent/hooks/ingest.ts and agent/instructions/arm.ts now ships in the package;
 * upgrades come through npm, not copy-paste.
 *
 * The three arms are Acme's to define — the extension supplies the bandit, the
 * grading loop, and the labels; the consuming agent supplies the styles it
 * wants to test (warm/terse mirror CONFIGS in src/tickets.ts for Part 1's batch
 * A/B; `balanced` is the live-only third candidate).
 *
 * To override a contribution (approval-gate the tool, swap the resolver), turn
 * this file into a directory mount: agent/extensions/jetty/extension.ts plus an
 * override slot — see https://eve.dev/docs/extensions#overrides.
 */
import jetty from "@jetty/eve";

const MODEL = process.env.EVE_MODEL ?? "anthropic/claude-sonnet-4.6";

// Illustrative $/1M tokens (mirrors src/cost.ts). Tune to your real rates.
const PRICES: Record<string, { in: number; out: number }> = {
  "anthropic/claude-sonnet-4.6": { in: 3, out: 15 },
  "anthropic/claude-opus-4.8": { in: 15, out: 75 },
};
const price = PRICES[MODEL] ?? { in: 3, out: 15 };

export default jetty({
  collection: process.env.JETTY_COLLECTION ?? "",
  task: process.env.JETTY_AGENT_TASK ?? "triage-live",
  author: process.env.JETTY_AUTHOR ?? "eve-dev@acme.example",
  judgeMode: process.env.JUDGE_MODE === "simple_judge" ? "simple_judge" : "ingest",
  passBar: 3,

  // The candidate arms the bandit chooses among (keys become eval.config labels).
  arms: {
    warm:
      "write draft_reply as a warm, specific first response: acknowledge the problem, " +
      "give a concrete next step, and match the customer's tier.",
    terse:
      "write draft_reply as a single terse sentence. Do not apologize, do not add steps " +
      "or detail, do not personalize.",
    balanced:
      "write draft_reply as a brief but caring reply: one line of acknowledgement plus one " +
      "concrete next step. Never promise or confirm an outcome you can't guarantee (a refund, " +
      "a credit, uptime) — offer the step or the process instead.",
  },
  contract:
    "Respond with ONLY the triage JSON object " +
    '{ "category": string, "priority": number (1=highest..5=lowest), "draft_reply": string } ' +
    "— no prose, no code fences.",

  bandit: process.env.JETTY_BANDIT === "off" ? "off" : "thompson",
  banditMinPerArm: Number(process.env.BANDIT_MIN_PER_ARM ?? 5),
  banditEpisodeLen: Number(process.env.BANDIT_EPISODE_LEN ?? 3),
  banditWindow: Number(process.env.BANDIT_WINDOW ?? 60),
  banditRefreshMs: Number(process.env.BANDIT_REFRESH_MS ?? 8000),

  priceInPerMTok: price.in,
  priceOutPerMTok: price.out,
});
