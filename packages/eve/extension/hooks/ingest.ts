/**
 * Live ingest hook — every finished turn lands in Jetty.
 *
 * eve has no single "turn finished, here's the text + token usage" callback —
 * `turn.completed` carries only a turnId. So we accumulate across the turn's
 * stream events (in the extension's durable session state, shared with the arm
 * resolver) and flush on completion:
 *   - message.received  → the user's message
 *   - message.completed → the assistant's reply
 *   - step.completed    → token usage (eve reports tokens, not dollars)
 * On turn.completed we parse the reply's JSON (if any), estimate cost, read
 * back which arm this turn ran, and either ingest an UNGRADED trajectory (the
 * default — an out-of-band grader scores it a beat later, so grading never
 * blocks the chat) or, with `judgeMode: "simple_judge"`, run the configured
 * Jetty task as a native LLM-judge and label its verdict inline.
 *
 * Best-effort by design: a thrown hook becomes `turn.failed` in eve, so every
 * side effect is wrapped. With no `collection` configured the hook no-ops and
 * the chat is unaffected, so the consuming agent is safe to run without Jetty.
 */
import { defineHook } from "eve/hooks";
import type { JettyClient } from "@jetty/sdk";

import extension from "../extension";
import { jettyClient, msg, writeLabelsVerified } from "../lib/jetty";
import { extractJson, parseVerdict } from "../lib/json";
import { addTurnUsage, patchTurn, takeTurn } from "../lib/state";

/**
 * Format the judged content: the user's message, then the agent's output —
 * `key: value` lines when the reply is a JSON object (so a structured contract
 * like a triage arrives as clean fields), the raw text otherwise.
 */
function judgeItem(input: { subject: string; body: string }, output: Record<string, unknown>): string {
  const fields = Object.entries(output)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  return `INPUT:\n${input.subject}\n${input.body}\n\nAGENT OUTPUT:\n${fields}`;
}

/**
 * `judgeMode: "simple_judge"`: run the configured Jetty task (a native
 * `simple_judge` workflow — one LLM call, no sandbox) on this turn, then
 * promote its score — a step output — to `eval.*` labels so live boards and
 * label panels show it unchanged. Replaces the out-of-band grader: grading
 * happens inside the Jetty run.
 */
async function runJudge(
  jetty: JettyClient,
  input: { subject: string; body: string },
  output: Record<string, unknown>,
  arm: string,
  cost: number,
): Promise<void> {
  const { collection, task, passBar } = extension.config;

  // runAndWait returns the completed judge trajectory; the chat reply already streamed,
  // so this only delays the turn's idle event by the (sandbox-free) judge call.
  const traj = await jetty.runAndWait(
    collection,
    task,
    { item: judgeItem(input, output), input },
    { pollMs: 2000, timeoutMs: 120_000 },
  );

  const out = (traj.steps?.judge?.outputs ?? {}) as Record<string, unknown>;
  const results = out.results as Array<{ score?: number; raw_result?: string }> | undefined;
  const score = Number(out.average_score ?? results?.[0]?.score);
  const ok = Number.isFinite(score);
  const verdict = parseVerdict(results?.[0]?.raw_result);
  const violation = verdict.policy_violation === true;
  // The pass bar, plus a hard policy floor: a reply that overpromises never passes,
  // however warm it reads. (The rubric already caps the score, but the floor makes
  // the gate independent of the judge honouring that instruction.)
  const pass = ok && score >= passBar && !violation;
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
  await writeLabelsVerified(jetty, id, labels);
  console.log(
    `[@jetty/eve] ${arm} turn → judged ${id}: ${ok ? score.toFixed(1) : "?"} ` +
      `${pass ? "PASS" : "fail"}${violation ? " ⚠ policy" : ""}`,
  );
}

export default defineHook({
  events: {
    "message.received"(event) {
      patchTurn(event.data.turnId, { input: event.data.message });
    },
    "step.completed"(event) {
      addTurnUsage(
        event.data.turnId,
        event.data.usage?.inputTokens ?? 0,
        event.data.usage?.outputTokens ?? 0,
      );
    },
    "message.completed"(event) {
      if (event.data.message) patchTurn(event.data.turnId, { reply: event.data.message });
    },
    async "turn.completed"(event, ctx) {
      const turnId = event.data.turnId;
      const t = takeTurn(turnId);
      const jetty = jettyClient();
      if (!jetty || !t?.reply) return;

      const { collection, task, author, judgeMode, priceInPerMTok, priceOutPerMTok } =
        extension.config;
      const output = extractJson(t.reply) ?? { text: t.reply };
      const body = t.input ?? "";
      const input = { subject: body.split("\n")[0]?.slice(0, 80) ?? "", body };
      const cost = (t.inTok / 1e6) * priceInPerMTok + (t.outTok / 1e6) * priceOutPerMTok;
      const arm = t.arm ?? "unknown";

      try {
        if (judgeMode === "simple_judge") {
          await runJudge(jetty, input, output, arm, cost);
        } else {
          // eve's turnId is per-session (turn_0, turn_1, …), so prefix the session id —
          // trajectory ids are global to the Jetty task, and separate chat sessions
          // would otherwise all collide on "turn_0" and overwrite each other.
          const trajId = `${ctx.session.id}-${turnId}`;
          const { trajectory_id } = await jetty.ingestTrajectory(collection, task, {
            trajectory_id: trajId,
            input,
            output,
            status: "completed",
            source: "eve-dev",
            author,
            cost_usd: cost,
            labels: { "eval.config": arm, "eval.source": "eve-dev" },
            metadata: { sessionId: ctx.session.id, turnId, arm },
          });
          console.log(
            `[@jetty/eve] ${arm} turn → ${collection}/${task} (${trajectory_id}) — ungraded`,
          );
        }
      } catch (err) {
        console.warn(`[@jetty/eve] ${judgeMode} failed (chat unaffected): ${msg(err)}`);
      }
    },
  },
});
