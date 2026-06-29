/**
 * The flagship: **A/B-eval an eve agent and catch a regression** — eve runs the
 * agent, Jetty grades + stores every run, this script orchestrates the comparison.
 *
 *   npx eve dev          # terminal 1: serve the agent at http://127.0.0.1:2000
 *   npm run ab-eval      # terminal 2: drive both configs, grade each on Jetty
 *
 * For each config (v1 warm vs v2 terse) × each ticket:
 *   1. eve drafts a triage (it owns the loop). One agent; the config's style is
 *      injected per prompt (see agent-prompt.ts), driven over the typed `eve/client`.
 *   2. @jetty/sdk grades the draft with an INDEPENDENT Jetty grader (a different
 *      model/rubric the agent never sees) via `gradeWithJetty` — upload, run,
 *      read grade.json, label — in one call.
 *   3. The labelled trajectory is the durable, comparable eval record.
 * Then aggregate into one verdict table: which config regressed below the bar.
 *
 * Requires a running eve agent (`npx eve dev`), JETTY_API_TOKEN, JETTY_COLLECTION,
 * and a deployed `triage-grader` (run `npm run deploy-grader` once).
 */
import { Client } from "eve/client";
import { JettyClient, gradeWithJetty } from "@jetty/sdk";
import { CONFIGS, TICKETS } from "./tickets.js";
import { triagePrompt, extractTriage } from "./agent-prompt.js";
import { aggregate, renderVerdict, type RunResult } from "./eval.js";
import { renderReportHtml, writeAndOpenReport } from "./report.js";
import { estimateCostFromEvents } from "./cost.js";

interface Grade {
  total: number;
  pass: boolean;
}

async function main(): Promise<void> {
  const collection = process.env.JETTY_COLLECTION ?? "jontesteroni11";
  const gradeTask = process.env.JETTY_GRADE_TASK ?? "triage-grader";
  const author = process.env.JETTY_AUTHOR ?? "eve@acme.example";
  const useTrialKeys = process.env.JETTY_USE_TRIAL_KEYS === "true";
  const eveUrl = process.env.EVE_URL ?? "http://127.0.0.1:2000";
  const model = process.env.EVE_MODEL ?? "anthropic/claude-sonnet-4.6";
  const n = Number(process.env.EVAL_TICKETS ?? 2);
  const tickets = TICKETS.slice(0, Math.max(1, n));

  const eve = new Client({ host: eveUrl });
  const jetty = new JettyClient();

  const results: RunResult[] = [];
  for (const config of CONFIGS) {
    for (const ticket of tickets) {
      // A fresh eve session per case so conversations don't leak; the one agent
      // serves both configs, with the warm/terse style injected per prompt.
      const session = eve.session();
      const response = await session.send(triagePrompt(config, ticket));
      const turn = await response.result();
      if (turn.status === "failed") {
        throw new Error(`eve turn failed for ${config.id}/${ticket.id} (status=failed)`);
      }
      const triage = extractTriage(turn.message ?? "");
      const costUsd = estimateCostFromEvents(turn.events, model);

      // Grade the draft server-side and record it on the trajectory — upload, run
      // the grader, read grade.json, and label, in one SDK call. The labels can read
      // the grade itself, so `eval.grade` is the score.
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
          "eval.cost_est_usd": costUsd.toFixed(6),
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
  console.log(`\n${renderVerdict(verdict)}\n`);

  const html = renderReportHtml(verdict, results, { mode: "live", collection, task: gradeTask });
  const reportPath = writeAndOpenReport(html);
  console.log(`📄 Opened a browser report → ${reportPath}`);
}

main().catch((err) => {
  console.error("✗ ab-eval failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
