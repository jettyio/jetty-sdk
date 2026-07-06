/**
 * Deploy `triage-live` as a native `simple_judge` task — the Part 2b judge.
 *
 *   JETTY_API_TOKEN=... JETTY_COLLECTION=... npm run deploy-judge
 *
 * Part 2 (the default) records each eve turn as a trajectory and an out-of-band
 * grade-watcher scores it with the runbook grader. Part 2b instead makes `triage-live`
 * a real Jetty task whose workflow is a single `simple_judge` step (LLM-as-judge, no
 * sandbox). With `JUDGE_MODE=simple_judge` the eve hook RUNS this task per turn and
 * labels its score — so there's no grade-watcher to run. The rubric below is plain
 * English; edit it and redeploy.
 *
 * simple_judge routes through LiteLLM, so it works on a collection that only has an
 * OpenRouter key (the default here). Override with JUDGE_MODEL / JUDGE_MODEL_PROVIDER.
 *
 * SDK surface: setEnvironmentVars, getTask, createTask, updateTask.
 */
import { JettyClient, JettyNotFoundError } from "@jetty/sdk";

const COLLECTION = process.env.JETTY_COLLECTION ?? "jetty-vercel-demo";
const TASK = process.env.JETTY_AGENT_TASK ?? "triage-live";
const MODEL = process.env.JUDGE_MODEL ?? "anthropic/claude-sonnet-4.6";
const MODEL_PROVIDER = process.env.JUDGE_MODEL_PROVIDER ?? "openrouter";

/**
 * The grading rubric (plain English). simple_judge applies it as the `instruction`.
 *
 * It scores four dimensions plus an overall 1-5. `score` and `explanation` stay
 * top-level so simple_judge's scale parser reads them unchanged; `dimensions` and
 * `policy_violation` ride along in the judge's raw_result JSON, where the ingest
 * hook and the live monitor pick them up.
 */
const RUBRIC =
  "You are a STRICT grader for a support-ticket triage produced by an AI agent. You are given the " +
  "original TICKET and the agent's TRIAGE RESPONSE (category, priority, draft_reply). Grade the " +
  "draft_reply as a FIRST RESPONSE to the customer. Be demanding and use the FULL 1-5 range: a run-of-" +
  "the-mill reply is a 3, and you should give 2s and 4s freely. Reserve 5 for a genuinely excellent " +
  "reply and 1 for a bad one — do not cluster everything at 4-5.\n\n" +
  "Score each dimension 1-5:\n" +
  "- empathy: opens by acknowledging THIS customer's specific situation in a natural human voice (5) " +
  "vs a generic opener that could be pasted onto any ticket ('Thanks for reaching out') (3) vs terse " +
  "or dismissive (1).\n" +
  "- actionability: gives a concrete, correct next step tailored to THIS ticket that moves it forward " +
  "now (5) vs a vague or boilerplate step like 'our team will look into it' (2-3) vs no next step (1). " +
  "A step that is generic, hedged, or wrong for this ticket caps this dimension at 2.\n" +
  "- accuracy: the category is right AND the priority fits real urgency (a full outage, security, or " +
  "billing problem is high priority; a how-to or general question is low), and the reply answers what " +
  "was actually asked (5) vs mis-categorised, wrong priority, or off-topic (1-2).\n" +
  "- policy: Acme first responses may NOT confirm or promise that a refund/credit has been or will be " +
  "processed (only billing can — support may say it has escalated), may NOT guarantee non-standard " +
  "deadlines, SLAs, or outcomes (e.g. '100% uptime', 'fixed by tomorrow'), and may NOT request " +
  "passwords or share account-security details. 5 = fully compliant; 1 = clearly commits Acme to " +
  "something a first response cannot.\n\n" +
  "Set policy_violation=true if the reply breaks ANY policy rule above. Then give an overall score " +
  "1-5 that reflects the WHOLE reply (not a simple average), scored strictly: 5 = specific, correct, " +
  "compliant AND appropriately concise (no padding); 4 = solid with one minor weakness; 3 = adequate " +
  "but generic or missing a specific next step; 2 = weak on two or more dimensions; 1 = terse, wrong, " +
  "or non-compliant. A rambling or padded reply that buries the next step loses a point. If " +
  "policy_violation is true the overall score must be at most 2, no matter how warm the reply reads.\n\n" +
  "Return ONLY JSON, no prose, no code fences:\n" +
  '{"score": <1-5>, "explanation": "<one or two sentences>", ' +
  '"dimensions": {"empathy": <1-5>, "actionability": <1-5>, "accuracy": <1-5>, "policy": <1-5>}, ' +
  '"policy_violation": <true|false>}';

function buildWorkflow(): unknown {
  return {
    init_params: { item: "" }, // the per-turn content to judge is supplied at run time
    step_configs: {
      judge: {
        activity: "simple_judge",
        item_path: "init_params.item",
        instruction: RUBRIC,
        judge_type: "scale",
        scale_range: [1, 5],
        model: MODEL,
        model_provider: MODEL_PROVIDER,
        temperature: 0.2,
        with_explanation: true,
      },
    },
    steps: ["judge"],
  };
}

async function main(): Promise<void> {
  const jetty = new JettyClient();

  const orKey = process.env.OPENROUTER_API_KEY;
  if (MODEL_PROVIDER === "openrouter" && orKey) {
    await jetty.setEnvironmentVars(COLLECTION, { OPENROUTER_API_KEY: orKey });
    console.log("[env] pushed OPENROUTER_API_KEY");
  }

  const workflow = buildWorkflow();
  const description = "Triage live judge — native simple_judge LLM-as-judge";
  try {
    await jetty.getTask(COLLECTION, TASK);
    await jetty.updateTask(COLLECTION, TASK, { workflow, description });
    console.log(`[task] updated ${COLLECTION}/${TASK} (simple_judge, ${MODEL_PROVIDER})`);
  } catch (e) {
    if (e instanceof JettyNotFoundError) {
      await jetty.createTask(COLLECTION, TASK, workflow, description);
      console.log(`[task] created ${COLLECTION}/${TASK} (simple_judge, ${MODEL_PROVIDER})`);
    } else {
      throw e;
    }
  }
  console.log(`✓ deployed: ${COLLECTION}/${TASK}  — run with JUDGE_MODE=simple_judge`);
}

main().catch((err) => {
  console.error("✗ deploy-judge failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
