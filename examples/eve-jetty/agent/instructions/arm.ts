/**
 * Per-turn A/B arm selection for the LIVE demo (`eve dev`).
 *
 * The batch harness (src/ab-eval.ts) injects the warm/terse style per send from
 * OUTSIDE the agent — it controls every prompt. A live `eve dev` chat has no such
 * driver: a human just types a support request. So the agent has to pick its own
 * arm on every turn. This is eve's dynamic-instructions seam: a resolver that runs
 * server-side on `turn.started` (once per turn, before the model call) and
 * contributes a system message on top of the always-on agent/instructions.md.
 *
 * It records the chosen arm in a module-level Map keyed by eve's `turnId`; the
 * companion hook (agent/hooks/ingest.ts) runs in the SAME `eve dev` process and
 * reads it back on `turn.completed`, so every ingested trajectory is labelled with
 * the arm it actually ran. Allowed dynamic-instruction events are only
 * {session.started, turn.started} — `turn.started` re-resolves the prompt per turn.
 *
 * The two styles mirror CONFIGS in src/tickets.ts. They're inlined here (rather
 * than imported across the src/ boundary) so eve's agent loader stays self-contained.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

export type Arm = "warm" | "terse";

const ARM_STYLE: Record<Arm, string> = {
  warm:
    "write draft_reply as a warm, specific first response: acknowledge the problem, " +
    "give a concrete next step, and match the customer's tier.",
  terse:
    "write draft_reply as a single terse sentence. Do not apologize, do not add steps " +
    "or detail, do not personalize.",
};

/**
 * turnId → arm, shared with the ingest hook. Stored on `globalThis` (not a plain
 * module export) because eve loads each authored module as its own bundle, so a
 * normal `import` would hand the hook a DIFFERENT Map instance than the resolver
 * writes to — and the arm would never reach the ingested trajectory. The global
 * key is the single source of truth both files reach.
 */
const ARM_MAP_KEY = "__eveJettyArmForTurn";
const g = globalThis as Record<string, unknown>;
export const armForTurn: Map<string, Arm> =
  (g[ARM_MAP_KEY] as Map<string, Arm> | undefined) ?? ((g[ARM_MAP_KEY] = new Map<string, Arm>()) as Map<string, Arm>);

const pickArm = (): Arm => (Math.random() < 0.5 ? "warm" : "terse");

export default defineDynamic({
  events: {
    "turn.started": (event) => {
      const turnId = (event as { data?: { turnId?: string } }).data?.turnId ?? "";
      const arm = pickArm();
      if (turnId) armForTurn.set(turnId, arm);
      return defineInstructions({
        markdown:
          `For THIS reply, ${ARM_STYLE[arm]}\n\n` +
          `Respond with ONLY the triage JSON object ` +
          `{ "category": string, "priority": number (1=highest..5=lowest), "draft_reply": string } ` +
          `— no prose, no code fences.`,
      });
    },
  },
});
