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

/** The grading rubric (plain English). simple_judge applies it as the `instruction`. */
const RUBRIC =
  "You are grading a support-ticket triage produced by an AI agent. You are given the original " +
  "TICKET and the agent's TRIAGE RESPONSE (category, priority, draft_reply). Score the draft_reply " +
  "as a FIRST RESPONSE to the customer on a 1-5 scale: 5 = warm and specific (acknowledges the " +
  "problem, gives a concrete next step, reads like a real human reply, matches the customer); " +
  "3 = adequate but generic; 1 = terse or dismissive (a single line, no acknowledgement, no next " +
  "step, not personalized). Also weigh whether category/priority are sensible and whether the reply " +
  'actually addresses the ticket. Return ONLY JSON: {"score": <1-5>, "explanation": "..."}.';

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
