/**
 * Deploy the `triage-grader` Jetty runbook (the server-side judge the workflow
 * calls). Mirrors the hill-climb deploy pattern.
 *
 *   ANTHROPIC_API_KEY=... JETTY_API_TOKEN=... JETTY_COLLECTION=... npm run deploy-grader
 *
 * SDK surface: setEnvironmentVars, getTask, createTask, updateTask.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JettyClient, JettyNotFoundError } from "@jetty/sdk";

const COLLECTION = process.env.JETTY_COLLECTION ?? "jetty-vercel-demo";
const TASK = process.env.JETTY_GRADE_TASK ?? "triage-grader";

const here = dirname(fileURLToPath(import.meta.url));
const runbook = readFileSync(join(here, "..", "grader", "RUNBOOK.md"), "utf8");

function buildWorkflow(): unknown {
  return {
    init_params: {
      agent: "claude-code",
      model: "claude-sonnet-4-6",
      model_provider: "anthropic",
      snapshot: "python312-uv",
      instruction: runbook,
      vars: {},
      file_paths: [],
    },
    step_configs: {
      run: {
        cpus: 2,
        memory: "4G",
        activity: "runbook",
        agent_path: "init_params.agent",
        model_path: "init_params.model",
        snapshot_path: "init_params.snapshot",
        instruction_path: "init_params.instruction",
        files_path: "init_params.file_paths",
        template_variables_path: "init_params.vars",
      },
    },
    steps: ["run"],
  };
}

async function main(): Promise<void> {
  const jetty = new JettyClient();

  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    await jetty.setEnvironmentVars(COLLECTION, { ANTHROPIC_API_KEY: key });
    console.log("[env] pushed: ANTHROPIC_API_KEY");
  } else {
    console.log(
      "[env] no ANTHROPIC_API_KEY — that's fine: run the grader on Jetty's free trial " +
        "with JETTY_USE_TRIAL_KEYS=true (10 free runs, no key needed).",
    );
  }

  const workflow = buildWorkflow();
  const description = "Triage grader — scores a support-ticket triage (judge model)";
  try {
    await jetty.getTask(COLLECTION, TASK);
    await jetty.updateTask(COLLECTION, TASK, { workflow, description });
    console.log(`[task] updated ${COLLECTION}/${TASK}`);
  } catch (e) {
    if (e instanceof JettyNotFoundError) {
      await jetty.createTask(COLLECTION, TASK, workflow, description);
      console.log(`[task] created ${COLLECTION}/${TASK}`);
    } else {
      throw e;
    }
  }
  console.log(`✓ deployed: ${COLLECTION}/${TASK}`);
}

main().catch((err) => {
  console.error("✗ deploy failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
