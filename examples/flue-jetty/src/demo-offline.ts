/**
 * Offline demo — no keys, no network, instant.
 *
 *   npm run demo
 *
 * Shows the verdict you'd get from running two versions of the triage agent
 * over the ticket set and grading each with Jetty: one config clears the bar,
 * the other regressed. This is what the live run (`npm run eval`) produces for
 * real — every row backed by a Jetty trajectory.
 */
import { CONFIGS } from "./tickets.js";
import { aggregate, renderVerdict } from "./eval.js";
import { simulateRuns } from "./simulate.js";
import { renderReportHtml, writeAndOpenReport } from "./report.js";

const results = simulateRuns();
const verdict = aggregate(results, CONFIGS);

console.log("Acme Helpdesk — did my last change to the triage agent make it worse?");
console.log("(simulated; run `npm run eval` for the real thing)\n");
console.log(renderVerdict(verdict));

const html = renderReportHtml(verdict, results, { mode: "offline (simulated)" });
const path = writeAndOpenReport(html);
console.log(`\n📄 Opened a browser report → ${path}`);
