/**
 * A native eve eval: drive the triage agent on one ticket and gate on the
 * JSON-output contract. eve runs and scores it; the `Jetty()` reporter wired in
 * `evals.config.ts` then persists this result to Jetty as a durable trajectory.
 *
 *   npx eve dev        # terminal A: serve the agent
 *   npx eve eval       # terminal B: run this (and report to Jetty)
 *
 * This is the "did this commit break the contract" check (eve's own assertions);
 * `src/ab-eval.ts` is the complementary "which version is better" comparison
 * graded by an independent Jetty rubric.
 */
import { defineEval } from "eve/evals";

import { triagePrompt } from "../src/agent-prompt.js";
import { CONFIGS, TICKETS } from "../src/tickets.js";

export default defineEval({
  description: "Triage agent returns the JSON triage contract for a billing ticket",
  async test(t) {
    const ticket = TICKETS.find((x) => x.id === "double-charge") ?? TICKETS[0];

    const turn = await t.send(triagePrompt(CONFIGS[0], ticket));
    turn.expectOk(); // gate: the turn completed without erroring

    // The shared contract (agent/instructions.md) requires a JSON object with
    // these keys — soft checks the reporter records as scores.
    t.messageIncludes("category");
    t.messageIncludes("draft_reply");
  },
});
