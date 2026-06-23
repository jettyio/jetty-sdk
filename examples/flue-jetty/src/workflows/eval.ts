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
import { JettyClient, gradeWithJetty } from "@jetty/sdk";
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
      const costUsd = drafted.usage.cost.total;

      // Grade the draft server-side and record the result on the trajectory —
      // upload, run the grader, read grade.json, and label, in one SDK call.
      // The labels can read the grade itself, so `eval.grade` is the score.
      const { grade, trajectoryId } = await gradeWithJetty<Grade>(jetty, collection, gradeTask, {
        files: [{ filename: "case.json", data: JSON.stringify({ ticket, triage }) }],
        initParams: { vars: { prompt: "Run the grader." } },
        pollMs: 4000,
        useTrialKeys,
        author,
        parseGrade: (bytes) => {
          const g = JSON.parse(new TextDecoder().decode(bytes)) as Grade;
          return { total: Number(g.total), pass: Boolean(g.pass) };
        },
        labels: (g) => ({
          "eval.config": config.id,
          "eval.ticket": ticket.id,
          "eval.grade": g.total.toFixed(2),
          "eval.pass": String(g.pass),
          "eval.cost_usd": costUsd.toFixed(6),
        }),
      });

      results.push({
        configId: config.id,
        ticketId: ticket.id,
        total: grade.total,
        pass: grade.pass,
        costUsd,
        trajectoryId,
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
