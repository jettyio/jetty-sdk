/**
 * Render the eval result as a self-contained, browser-friendly HTML report,
 * styled with the Jetty design system (ds01.jetty.bot tokens). Used by both the
 * offline demo and the live run.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { exec } from "node:child_process";
import type { RunResult, Verdict } from "./eval.js";

export interface ReportContext {
  mode: "offline (simulated)" | "live";
  collection?: string;
  task?: string;
  graderLabel?: string;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function trajectoryUrl(ctx: ReportContext, r: RunResult): string | null {
  if (!r.trajectoryId || !ctx.collection || !ctx.task) return null;
  return `https://flows.jetty.io/${ctx.collection}/${ctx.task}/${r.trajectoryId}`;
}

export function renderReportHtml(verdict: Verdict, results: RunResult[], ctx: ReportContext): string {
  const winner = verdict.summaries.find((s) => s.configId === verdict.winnerId)!;
  const regressed = verdict.summaries.find((s) => verdict.regressedIds.includes(s.configId));
  const takeaway = regressed
    ? `${esc(regressed.label)} ${regressed.avgCostUsd < winner.avgCostUsd ? "is cheaper but " : ""}fails the bar (${verdict.bar.toFixed(1)}). Keep ${esc(winner.label)}.`
    : `${esc(winner.label)} clears the bar (${verdict.bar.toFixed(1)}).`;

  const verdictRows = verdict.summaries
    .map((s) => {
      const state =
        s.configId === verdict.winnerId
          ? `<span class="badge pass">✓ pass</span>`
          : verdict.regressedIds.includes(s.configId)
            ? `<span class="badge fail">✗ regressed</span>`
            : "";
      return `<tr>
        <td class="mono">${esc(s.label)}</td>
        <td class="num">${s.passes}/${s.runs}</td>
        <td class="num">${s.avgScore.toFixed(1)}</td>
        <td class="num">$${s.avgCostUsd.toFixed(4)}</td>
        <td>${state}</td>
      </tr>`;
    })
    .join("\n");

  const runRows = results
    .map((r) => {
      const url = trajectoryUrl(ctx, r);
      const cfg = verdict.summaries.find((s) => s.configId === r.configId);
      const link = url ? `<a href="${esc(url)}">${esc(r.trajectoryId ?? "")}</a>` : "—";
      return `<tr>
        <td class="mono">${esc(cfg?.label ?? r.configId)}</td>
        <td class="mono">${esc(r.ticketId)}</td>
        <td class="num">${r.total.toFixed(1)}</td>
        <td>${r.pass ? '<span class="badge pass">pass</span>' : '<span class="badge fail">fail</span>'}</td>
        <td class="num">$${r.costUsd.toFixed(4)}</td>
        <td class="mono small">${link}</td>
      </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Acme Helpdesk — agent eval</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;500;600;700&family=Nunito+Sans:wght@400;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root {
    --bone-50: #faf8f3; --white: #ffffff; --bone-100: #f3efe4; --bone-200: #e8e1ce;
    --ink: #0a1230; --stone-700: #44403c; --stone-500: #78716c; --stone-400: #a8a29e;
    --amber: #f0a91f; --lavender: #7c5fd9; --sage: #7c9885; --red: #c0392b;
    --radius-lg: 10px; --radius-xl: 16px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bone-50); color: var(--stone-700);
    font-family: "Nunito Sans", system-ui, sans-serif; line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .container { max-width: 760px; margin: 0 auto; padding: 64px 24px 96px; }
  .eyebrow {
    font-family: "Geist Mono", monospace; font-size: 12px; letter-spacing: .12em;
    text-transform: uppercase; color: var(--stone-500); margin-bottom: 14px;
  }
  h1 {
    font-family: "Outfit", sans-serif; font-weight: 600; color: var(--ink);
    font-size: 40px; line-height: 1.12; margin: 0 0 16px; letter-spacing: -.01em;
  }
  h1 .accent { color: var(--lavender); }
  .lede { font-size: 17px; color: var(--stone-700); margin: 0 0 8px; }
  .lede .pill {
    display: inline-block; font-family: "Geist Mono", monospace; font-size: 12px;
    background: var(--bone-100); border: 1px solid var(--bone-200); border-radius: 999px;
    padding: 2px 10px; color: var(--ink); margin: 0 2px;
  }
  .card {
    background: var(--white); border: 1px solid var(--bone-200); border-radius: var(--radius-xl);
    padding: 28px 28px 8px; margin: 32px 0; box-shadow: 0 1px 2px rgba(10,18,48,.04);
  }
  h2 {
    font-family: "Outfit", sans-serif; font-weight: 600; color: var(--ink);
    font-size: 14px; text-transform: uppercase; letter-spacing: .08em; margin: 0 0 16px;
  }
  table { width: 100%; border-collapse: collapse; font-size: 15px; }
  th {
    text-align: left; font-family: "Geist Mono", monospace; font-weight: 500; font-size: 11px;
    letter-spacing: .08em; text-transform: uppercase; color: var(--stone-500);
    padding: 0 12px 10px; border-bottom: 1px solid var(--bone-200);
  }
  td { padding: 14px 12px; border-bottom: 1px solid var(--bone-100); color: var(--ink); }
  tr:last-child td { border-bottom: none; }
  .num { text-align: right; font-variant-numeric: tabular-nums; font-family: "Geist Mono", monospace; }
  .mono { font-family: "Geist Mono", monospace; }
  .small { font-size: 12px; }
  td a { color: var(--lavender); text-decoration: none; }
  td a:hover { text-decoration: underline; }
  .badge {
    display: inline-block; font-family: "Geist Mono", monospace; font-size: 11px; font-weight: 500;
    padding: 3px 10px; border-radius: 999px; letter-spacing: .02em;
  }
  .badge.pass { background: rgba(124,152,133,.16); color: #3a6b4e; }
  .badge.fail { background: rgba(192,57,43,.12); color: var(--red); }
  .takeaway {
    font-family: "Outfit", sans-serif; font-size: 18px; color: var(--ink); font-weight: 500;
    margin: 24px 4px 28px; padding-left: 14px; border-left: 3px solid var(--amber);
  }
  footer { color: var(--stone-500); font-size: 13px; margin-top: 40px; }
  footer code { font-family: "Geist Mono", monospace; color: var(--stone-700); }
  footer a { color: var(--lavender); }
</style>
</head>
<body>
  <div class="container">
    <div class="eyebrow">Acme Helpdesk · agent eval</div>
    <h1>Did my change <span class="accent">regress</span><br />the triage agent?</h1>
    <p class="lede">
      ${verdict.ticketCount} ticket${verdict.ticketCount === 1 ? "" : "s"}
      · run <span class="pill">${esc(ctx.mode)}</span>
      · graded by <span class="pill">${esc(ctx.graderLabel ?? "rubric (independent)")}</span>
    </p>

    <div class="card">
      <h2>Verdict</h2>
      <table>
        <thead><tr><th>config</th><th class="num">pass</th><th class="num">avg</th><th class="num">$/run</th><th>status</th></tr></thead>
        <tbody>${verdictRows}</tbody>
      </table>
    </div>
    <p class="takeaway">→ ${takeaway}</p>

    <div class="card">
      <h2>Per-run results</h2>
      <table>
        <thead><tr><th>config</th><th>ticket</th><th class="num">score</th><th>result</th><th class="num">cost</th><th>trajectory</th></tr></thead>
        <tbody>${runRows}</tbody>
      </table>
    </div>

    <footer>
      Each run is a Jetty <strong>trajectory</strong> graded by an independent rubric (the agent
      didn't write its own grade), labelled with <code>config</code> + <code>score</code> +
      <code>cost</code> — so you can compare configs and catch regressions across releases.
      Built with <a href="https://www.npmjs.com/package/@jetty/sdk">@jetty/sdk</a>.
    </footer>
  </div>
</body>
</html>`;
}

/** Write the report to disk and try to open it in the default browser. */
export function writeAndOpenReport(html: string, file = "report.html"): string {
  const path = resolve(file);
  writeFileSync(path, html, "utf8");
  // Don't launch a browser in CI/headless or when explicitly suppressed.
  if (!process.env.CI && !process.env.JETTY_NO_OPEN) {
    const opener =
      process.platform === "darwin"
        ? `open "${path}"`
        : process.platform === "win32"
          ? `start "" "${path}"`
          : `xdg-open "${path}"`;
    exec(opener, () => {
      /* best-effort; ignore failures (headless/CI/SSH) */
    });
  }
  return path;
}
