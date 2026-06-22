/**
 * The flagship: **A/B-eval an agent and catch a regression** — Flue runs the
 * agent, Jetty grades + stores every run, the SDK orchestrates the comparison.
 *
 *   npx flue run eval --target node --payload '{"tickets":2}'
 *
 * For each config (v1 warm vs v2 terse) × each ticket:
 *   1. Flue drafts a triage (it owns the agent loop).
 *   2. @jetty/sdk sends the draft to the Jetty grader (a different model) and
 *      waits for the trajectory — the durable, labelled eval record.
 *   3. We label the trajectory with config + score + cost, collect the result.
 * Then we aggregate into one verdict table: which config regressed below the bar.
 *
 * Requires ANTHROPIC_API_KEY, JETTY_API_TOKEN, JETTY_COLLECTION, and a deployed
 * `triage-grader` (run `npm run deploy-grader` once).
 */
import type { FlueContext } from "@flue/runtime";
import { JettyClient, type Trajectory } from "@jetty/sdk";
import { CONFIGS, TICKETS } from "../tickets.js";
import { extractTriage, makeTriageAgent } from "../agent.js";
import { aggregate, renderVerdict, type RunResult } from "../eval.js";
import { renderReportHtml, writeAndOpenReport } from "../report.js";

interface Payload {
  /** How many tickets to run (default 2 — each grade is a server-side run). */
  tickets?: number;
}

interface Grade {
  total: number;
  pass: boolean;
}

/** Download the grader's grade.json off the completed trajectory. */
async function readGrade(jetty: JettyClient, trajectory: Trajectory): Promise<Grade> {
  const outputs = trajectory.steps?.run?.outputs ?? {};
  const files = (outputs.files ?? outputs.results_files ?? []) as unknown[];
  const keys = files
    .map((f) => (typeof f === "string" ? f : (f as { path?: string }).path))
    .filter((k): k is string => typeof k === "string");
  const key = keys.find((k) => k.endsWith("grade.json"));
  if (!key) throw new Error(`grader produced no grade.json (files: ${keys.join(", ") || "none"})`);
  const bytes = (await jetty.downloadFile(key)).bytes;
  const g = JSON.parse(new TextDecoder().decode(bytes)) as { total: number; pass: boolean };
  return { total: Number(g.total), pass: Boolean(g.pass) };
}

export async function run(ctx: FlueContext<Payload>) {
  const jetty = new JettyClient();
  const collection = process.env.JETTY_COLLECTION ?? "jontesteroni11";
  const gradeTask = process.env.JETTY_GRADE_TASK ?? "triage-grader";
  const author = process.env.JETTY_AUTHOR ?? "eval@acme.example";
  // Grade on Jetty's free trial (no API key / key-push) when this is set.
  const useTrialKeys = process.env.JETTY_USE_TRIAL_KEYS === "true";
  const n = ctx.payload?.tickets ?? Number(process.env.EVAL_TICKETS ?? 2);
  const tickets = TICKETS.slice(0, Math.max(1, n));

  const results: RunResult[] = [];
  for (const config of CONFIGS) {
    // One harness per config; a fresh session per ticket so cases don't leak.
    const harness = await ctx.init(makeTriageAgent(config), { name: config.id });
    for (const ticket of tickets) {
      const session = await harness.session(`${config.id}-${ticket.id}`);
      const drafted = await session.prompt(JSON.stringify(ticket));
      const triage = extractTriage(drafted.text);

      // Upload the case as a file (no quoting issues) and grade it server-side.
      const graded = await jetty.runAndWait(
        collection,
        gradeTask,
        { vars: { prompt: "Run the grader." } },
        {
          pollMs: 4000,
          useTrialKeys,
          files: [{ filename: "case.json", data: JSON.stringify({ ticket, triage }) }],
        },
      );

      const grade = await readGrade(jetty, graded);
      const costUsd = drafted.usage.cost.total;

      // Record the eval result on the trajectory (Jetty's scoring primitive).
      const labels: [string, string][] = [
        ["eval.config", config.id],
        ["eval.ticket", ticket.id],
        ["eval.grade", grade.total.toFixed(2)],
        ["eval.pass", String(grade.pass)],
        ["eval.cost_usd", costUsd.toFixed(6)],
      ];
      for (const [k, v] of labels) {
        await jetty.addLabel(collection, gradeTask, graded.trajectory_id, k, v, author);
      }

      results.push({
        configId: config.id,
        ticketId: ticket.id,
        total: grade.total,
        pass: grade.pass,
        costUsd,
        trajectoryId: graded.trajectory_id,
      });
      console.log(`  ${config.label} · ${ticket.id}: ${grade.total.toFixed(1)} ${grade.pass ? "PASS" : "fail"}`);
    }
  }

  const verdict = aggregate(results, CONFIGS);
  const table = renderVerdict(verdict);
  console.log(`\n${table}\n`);

  const html = renderReportHtml(verdict, results, { mode: "live", collection, task: gradeTask });
  const reportPath = writeAndOpenReport(html);
  console.log(`📄 Opened a browser report → ${reportPath}`);

  return { verdict, results, reportPath };
}
