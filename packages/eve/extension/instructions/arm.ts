/**
 * Per-turn arm selection — the extension's dynamic-instructions contribution.
 *
 * A live chat has no external driver injecting styles per request, so the agent
 * picks its own arm on every turn via eve's dynamic-instructions seam: this
 * resolver runs server-side on `turn.started` (once per turn, before the model
 * call) and contributes a system message on top of the consuming agent's own
 * instructions. The arm comes from the episodic Thompson bandit (lib/bandit.ts),
 * rewarded by live Jetty pass-rates; with `bandit: "off"` or no Jetty client it
 * degrades to a fair coin, so the agent runs fine without Jetty.
 *
 * The chosen arm is recorded in the extension's session state (lib/state.ts);
 * the companion ingest hook reads it back on `turn.completed`, so every
 * ingested trajectory is labelled with the arm it actually ran. Allowed
 * dynamic-instruction events are only {session.started, turn.started} —
 * `turn.started` re-resolves the prompt per turn.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import extension from "../extension";
import { pickArm } from "../lib/bandit";
import { patchTurn } from "../lib/state";

export default defineDynamic({
  events: {
    "turn.started": (event) => {
      const { arms, contract } = extension.config;
      const names = Object.keys(arms);
      if (!names.length) {
        return contract ? defineInstructions({ markdown: contract }) : null;
      }
      const arm = pickArm(names);
      const turnId = (event as { data?: { turnId?: string } }).data?.turnId ?? "";
      if (turnId) patchTurn(turnId, { arm });
      return defineInstructions({
        markdown: `For THIS reply, ${arms[arm]}` + (contract ? `\n\n${contract}` : ""),
      });
    },
  },
});
