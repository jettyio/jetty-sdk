/**
 * The out-of-band grader — watch the live agent's runs and grade them.
 *
 *   npx eve dev          # terminal 1: serve the agent (randomizes warm/terse per turn)
 *   npm run grade-watch  # terminal 2: this — grade each ingested run on Jetty
 *   npm run board        # terminal 3: the live scoreboard (lights up as grades land)
 *
 * The eve dev hook (agent/hooks/ingest.ts) ingests every typed turn as an UNGRADED
 * trajectory under JETTY_AGENT_TASK. This watcher polls that task, finds the runs
 * that don't yet carry an `eval.grade` label, and grades each with the INDEPENDENT
 * Jetty grader — the same `triage-grader` task the batch demo uses (deploy once via
 * `npm run deploy-grader`). The grade is then written BACK onto the agent's own
 * trajectory with `addLabel`, so the scoreboard lights up. Grading is decoupled
 * from the chat: the agent never waits on it, and the rubric the agent never saw
 * is what scores it.
 *
 * Requires JETTY_API_TOKEN, JETTY_COLLECTION, and a deployed `triage-grader`.
 */
import { JettyClient, gradeWithJetty, type Trajectory } from "@jetty/sdk";

interface Grade {
  total: number;
  pass: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Flatten a trajectory's labels into a plain map for lookups. */
const labelMap = (t: Trajectory): Record<string, string> =>
  Object.fromEntries((t.labels ?? []).map((l) => [l.key, l.value]));

/** Grade one ingested agent trajectory and write the grade back onto it. */
async function gradeOne(
  jetty: JettyClient,
  opts: { collection: string; agentTask: string; gradeTask: string; author: string; useTrialKeys: boolean },
  t: Trajectory,
): Promise<void> {
  const { collection, agentTask, gradeTask, author, useTrialKeys } = opts;
  // ingest_trajectory stores the case as init_params.input + steps.eval.outputs.output.
  const ticket = t.init_params?.input ?? {};
  const evalOutputs = (t.steps?.eval?.outputs ?? {}) as Record<string, unknown>;
  const triage = evalOutputs.output ?? {};
  const arm = labelMap(t)["eval.config"] ?? "?";

  const { grade } = await gradeWithJetty<Grade>(jetty, collection, gradeTask, {
    files: [{ filename: "case.json", data: JSON.stringify({ ticket, triage }) }],
    initParams: { vars: { prompt: "Run the grader." } },
    pollMs: 3000,
    useTrialKeys,
    author,
    parseGrade: (bytes) => {
      const g = JSON.parse(new TextDecoder().decode(bytes)) as Grade;
      return { total: Number(g.total), pass: Boolean(g.pass) };
    },
  });

  // Write the grade onto the AGENT trajectory (not the grader's) so the board lights up.
  await jetty.addLabel(collection, agentTask, t.trajectory_id, "eval.grade", grade.total.toFixed(2), author);
  await jetty.addLabel(collection, agentTask, t.trajectory_id, "eval.pass", String(grade.pass), author);
  console.log(`  graded ${arm.padEnd(5)} ${t.trajectory_id}: ${grade.total.toFixed(1)} ${grade.pass ? "PASS ✅" : "fail ❌"}`);
}

async function main(): Promise<void> {
  const collection = process.env.JETTY_COLLECTION ?? "";
  const agentTask = process.env.JETTY_AGENT_TASK ?? "triage-live";
  const gradeTask = process.env.JETTY_GRADE_TASK ?? "triage-grader";
  const author = process.env.JETTY_AUTHOR ?? "eve-grader@acme.example";
  const useTrialKeys = process.env.JETTY_USE_TRIAL_KEYS === "true";
  const intervalMs = Number(process.env.GRADE_POLL_MS ?? 3000);
  if (!collection) throw new Error("Set JETTY_COLLECTION (and JETTY_API_TOKEN) — see .env.example.");

  const jetty = new JettyClient();
  const opts = { collection, agentTask, gradeTask, author, useTrialKeys };
  const inFlight = new Set<string>();
  console.log(
    `⚖️  grading ${collection}/${agentTask} via ${gradeTask}, polling every ${intervalMs}ms. Ctrl-C to stop.`,
  );

  for (;;) {
    try {
      const { trajectories } = await jetty.listTrajectories(collection, agentTask, 50, 1);
      const ungraded = (trajectories ?? []).filter(
        (t) => t.status === "completed" && !("eval.grade" in labelMap(t)) && !inFlight.has(t.trajectory_id),
      );
      await Promise.all(
        ungraded.map(async (t) => {
          inFlight.add(t.trajectory_id);
          try {
            await gradeOne(jetty, opts, t);
          } catch (err) {
            console.warn(`  grade failed ${t.trajectory_id}: ${errMsg(err)}`);
          } finally {
            inFlight.delete(t.trajectory_id);
          }
        }),
      );
    } catch (err) {
      console.warn(`poll error: ${errMsg(err)}`);
    }
    await sleep(intervalMs);
  }
}

main().catch((err) => {
  console.error("✗ grade-watcher failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
