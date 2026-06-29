/**
 * The live scoreboard — watch Jetty light up as you type into `eve dev`.
 *
 *   npm run board   # then open http://localhost:4500
 *
 * The real Jetty UI polls slowly and doesn't surface labels in its run list, so
 * this is a tiny self-contained board built for the demo: a Node server that
 * polls `listTrajectories` (token stays server-side) and serves an HTML page that
 * re-fetches every 2s. Each ingested turn appears immediately as a warm/terse row;
 * a beat later the out-of-band grader's `eval.grade` / `eval.pass` labels land and
 * the row flips from "grading…" to a green pass or red fail, and the warm-vs-terse
 * tallies update live.
 *
 * Requires JETTY_API_TOKEN + JETTY_COLLECTION. Reuses the same label chips idea as
 * Spot's trajectory table (eval.config / eval.grade / eval.pass).
 */
import { createServer } from "node:http";
import { JettyClient, type Trajectory } from "@jetty/sdk";

const COLLECTION = process.env.JETTY_COLLECTION ?? "";
const AGENT_TASK = process.env.JETTY_AGENT_TASK ?? "triage-live";
const PORT = Number(process.env.BOARD_PORT ?? 4500);
if (!COLLECTION) {
  console.error("✗ Set JETTY_COLLECTION (and JETTY_API_TOKEN) — see .env.example.");
  process.exit(1);
}

const jetty = new JettyClient();
const labelMap = (t: Trajectory): Record<string, string> =>
  Object.fromEntries((t.labels ?? []).map((l) => [l.key, l.value]));

interface Row {
  id: string;
  arm: string;
  subject: string;
  status: string;
  grade: number | null;
  pass: boolean | null;
  cost: number | null;
  created: string;
}

async function fetchRows(): Promise<Row[]> {
  const { trajectories } = await jetty.listTrajectories(COLLECTION, AGENT_TASK, 50, 1);
  return (trajectories ?? []).map((t) => {
    const L = labelMap(t);
    const input = (t.init_params?.input ?? {}) as { subject?: string; body?: string };
    return {
      id: t.trajectory_id,
      arm: L["eval.config"] ?? "?",
      subject: (input.subject || input.body || "").slice(0, 70),
      status: t.status,
      grade: "eval.grade" in L ? Number(L["eval.grade"]) : null,
      pass: "eval.pass" in L ? L["eval.pass"] === "true" : null,
      cost: "cost_est_usd" in L ? Number(L["cost_est_usd"]) : null,
      created: t.created,
    };
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Live A/B — warm vs terse</title>
<style>
  :root { --ink:#070154; --lav:#6d5efc; --paper:#f7f6fb; --line:#e6e3f2; --pass:#0f9d58; --fail:#e0218a; --pend:#c98a00; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif; color:var(--ink); background:var(--paper); }
  header { padding:22px 28px; border-bottom:1px solid var(--line); background:#fff; }
  h1 { margin:0; font-size:19px; letter-spacing:-0.01em; }
  .sub { color:#6b6a85; font-size:13px; margin-top:3px; }
  main { max-width:880px; margin:0 auto; padding:24px 28px 56px; }
  .cards { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:26px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:14px; padding:16px 18px; }
  .card h2 { margin:0 0 10px; font-size:14px; text-transform:uppercase; letter-spacing:0.06em; color:#6b6a85; }
  .big { font-size:30px; font-weight:650; letter-spacing:-0.02em; }
  .stat-row { display:flex; gap:18px; margin-top:8px; color:#3a3960; font-size:13px; }
  .stat-row b { color:var(--ink); font-weight:650; }
  .feed { background:#fff; border:1px solid var(--line); border-radius:14px; overflow:hidden; }
  .run { display:flex; align-items:center; gap:12px; padding:12px 16px; border-top:1px solid var(--line); }
  .run:first-child { border-top:none; }
  .chip { font-size:12px; font-weight:650; padding:3px 9px; border-radius:999px; white-space:nowrap; }
  .arm-warm { background:#efeaff; color:var(--lav); }
  .arm-terse { background:#eceaf2; color:#5a5878; }
  .arm-unknown { background:#f0eef6; color:#8a88a3; }
  .subject { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#3a3960; }
  .grade { font-variant-numeric:tabular-nums; }
  .g-pass { background:#e4f6ec; color:var(--pass); }
  .g-fail { background:#fde7f3; color:var(--fail); }
  .g-pend { background:#fdf3da; color:var(--pend); animation:pulse 1.1s ease-in-out infinite; }
  .cost { color:#9795b0; font-size:12px; font-variant-numeric:tabular-nums; min-width:64px; text-align:right; }
  .empty { padding:40px; text-align:center; color:#9795b0; }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.45; } }
  .live { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--pass); margin-right:6px; vertical-align:middle; animation:pulse 1.4s ease-in-out infinite; }
</style>
</head>
<body>
<header>
  <h1><span class="live"></span>Live A/B — warm vs terse</h1>
  <div class="sub">Type a support ticket into <code>eve dev</code>. Each turn is graded out of band by an independent Jetty rubric — this board updates every 2s.</div>
</header>
<main>
  <div class="cards" id="cards"></div>
  <div class="feed" id="feed"><div class="empty">Waiting for runs… start typing into <code>eve dev</code>.</div></div>
</main>
<script>
function summarize(rows, arm) {
  var r = rows.filter(function (x) { return x.arm === arm; });
  var graded = r.filter(function (x) { return x.grade !== null; });
  var passes = graded.filter(function (x) { return x.pass === true; }).length;
  var avg = graded.length ? (graded.reduce(function (s, x) { return s + x.grade; }, 0) / graded.length) : null;
  var passRate = graded.length ? Math.round((passes / graded.length) * 100) : null;
  return { n: r.length, graded: graded.length, passRate: passRate, avg: avg };
}
function card(arm, label) {
  return function (s) {
    return '<div class="card"><h2>' + label + '</h2>' +
      '<div class="big">' + (s.passRate === null ? '—' : s.passRate + '%') + '</div>' +
      '<div class="stat-row"><span><b>' + s.n + '</b> runs</span>' +
      '<span><b>' + s.graded + '</b> graded</span>' +
      '<span>avg <b>' + (s.avg === null ? '—' : s.avg.toFixed(1)) + '</b></span></div></div>';
  };
}
function gradeChip(x) {
  if (x.grade === null) return '<span class="chip grade g-pend">grading…</span>';
  var cls = x.pass ? 'g-pass' : 'g-fail';
  return '<span class="chip grade ' + cls + '">' + x.grade.toFixed(1) + (x.pass ? ' ✅' : ' ❌') + '</span>';
}
function armChip(arm) {
  var cls = arm === 'warm' ? 'arm-warm' : arm === 'terse' ? 'arm-terse' : 'arm-unknown';
  return '<span class="chip ' + cls + '">' + arm + '</span>';
}
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]; }); }
function render(rows) {
  rows.sort(function (a, b) { return (b.created || '').localeCompare(a.created || ''); });
  document.getElementById('cards').innerHTML =
    card('warm', 'v1 · warm')(summarize(rows, 'warm')) + card('terse', 'v2 · terse')(summarize(rows, 'terse'));
  var feed = document.getElementById('feed');
  if (!rows.length) { feed.innerHTML = '<div class="empty">Waiting for runs… start typing into <code>eve dev</code>.</div>'; return; }
  feed.innerHTML = rows.map(function (x) {
    return '<div class="run">' + armChip(x.arm) +
      '<span class="subject">' + (esc(x.subject) || '<em>—</em>') + '</span>' +
      '<span class="cost">' + (x.cost === null ? '' : '$' + x.cost.toFixed(4)) + '</span>' +
      gradeChip(x) + '</div>';
  }).join('');
}
function tick() {
  fetch('/api/runs').then(function (r) { return r.json(); })
    .then(function (rows) { if (Array.isArray(rows)) render(rows); })
    .catch(function () {});
}
tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;

createServer(async (req, res) => {
  if (req.url && req.url.startsWith("/api/runs")) {
    try {
      const rows = await fetchRows();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rows));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
}).listen(PORT, () => {
  console.log(`📊 live board → http://localhost:${PORT}  (watching ${COLLECTION}/${AGENT_TASK})`);
});
