/**
 * Jetty live monitor — the eve-jetty conference dashboard (folded into this example).
 *
 *   npm run monitor        # from examples/eve-jetty, then open http://localhost:4600
 *
 * It reads the SAME env as the rest of the example: the eve agent, the bandit, the
 * grader/judge, the feeder, and this monitor all resolve from examples/eve-jetty/.env,
 * so they point at one collection + one task and agree on the gate/bandit thresholds.
 * (This file lives one level below the example, so its `../.env` auto-load lands on
 * the shared examples/eve-jetty/.env — no separate config to keep in sync.)
 *
 * Watches JETTY_COLLECTION / JETTY_AGENT_TASK (jetty-vercel-demo / triage-live) and
 * streams every run to the browser over Server-Sent Events. Pairs with the eve-jetty
 * demo running in JUDGE_MODE=simple_judge: you type a support ticket into `npx eve dev`,
 * the agent replies, the reply is judged by a Jetty `simple_judge` step, and this monitor
 * shows the ticket → reply → judge verdict appear in real time.
 *
 * Beyond the card feed it renders:
 *   - per-dimension judge scores (empathy/actionability/accuracy/policy) + a POLICY flag
 *   - the live traffic-allocation bar (the agent's Thompson bandit steering toward the winner)
 *   - a release gate: SHIP/BLOCK once each arm has GATE_MIN_RUNS judged runs (defaults to
 *     BANDIT_MIN_PER_ARM so the gate and the agent's bandit arm at the same count) — and an
 *     optional one-shot Slack alert when the gate blocks an arm (SLACK_ALERT_CHANNEL)
 *   - a history strip (rolling pass-rate + cost-vs-grade scatter) and a deep link from
 *     every card to the same trajectory in the Jetty UI — the board is a lens, Jetty is
 *     the store.
 *
 * Zero dependencies (Node 18+ built-ins). Tokens stay server-side: the Jetty token is read
 * from JETTY_API_TOKEN (the same one the SDK uses); the Slack bot token from
 * SLACK_BOT_TOKEN, else SLACK_BOT_OAUTH.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Load KEY=value pairs from .env files into process.env (Node doesn't do this itself).
 *  Real env vars win; the shared example .env (../.env) is the common config, and a
 *  local ./.env can override it. The rest of the example loads the same file (via
 *  `set -a && . ./.env`), so this monitor needs no separate setup. */
function loadDotenv() {
  for (const p of [join(__dirname, ".env"), join(__dirname, "..", ".env")]) {
    let text;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      continue; // file may not exist — that's fine
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m || line.trimStart().startsWith("#")) continue;
      const key = m[1];
      if (process.env[key] !== undefined) continue; // never override an existing value
      process.env[key] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}
loadDotenv();

const API = process.env.JETTY_API_URL ?? "https://flows-api.jetty.io";
const UI = process.env.JETTY_UI_URL ?? "https://jetty.io";
const COLLECTION = process.env.JETTY_COLLECTION ?? "jetty-vercel-demo";
const TASK = process.env.JETTY_AGENT_TASK ?? "triage-live";
// MONITOR_PORT so a shared .env can set the board's port without colliding with a bare PORT.
const PORT = Number(process.env.MONITOR_PORT ?? process.env.PORT ?? 4600);
const POLL_MS = Number(process.env.POLL_MS ?? 1500);
const LIMIT = Number(process.env.LIMIT ?? 100);
// Arm the gate at the same judged-runs-per-arm count the agent's bandit uses to stop
// exploring (BANDIT_MIN_PER_ARM), so "the gate is ready" and "the bandit is exploiting"
// line up on stage. GATE_MIN_RUNS overrides if you want them to differ.
const GATE_MIN_RUNS = Number(process.env.GATE_MIN_RUNS ?? process.env.BANDIT_MIN_PER_ARM ?? 5);
const PASS_BAR = 4.0;

// Slack alert (optional): set SLACK_ALERT_CHANNEL (e.g. C0B3E7HLBQE for #jetty-alerts)
// to have the gate post ONCE per blocked arm when it flips to BLOCK.
const SLACK_CHANNEL = process.env.SLACK_ALERT_CHANNEL ?? "";

/** Read a KEY=value out of env first, then the example .env (../.env), then ./.env. */
function resolveSecret(envKey, dotenvKey) {
  if (process.env[envKey]) return process.env[envKey];
  for (const p of [join(__dirname, "..", ".env"), join(__dirname, ".env")]) {
    try {
      const env = readFileSync(p, "utf8");
      const m = env.match(new RegExp(`^${dotenvKey}=(.+)$`, "m"));
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch {
      /* try next */
    }
  }
  return null;
}

const TOKEN =
  process.env.JETTY_API_TOKEN ??
  resolveSecret("JETTY_API_TOKEN", process.env.JETTY_TOKEN_VAR ?? "JETTY_API_TOKEN_JETTY_VERCEL_DEMO");
if (!TOKEN) {
  console.error(
    "✗ No Jetty token. Set JETTY_API_TOKEN in examples/eve-jetty/.env (the same token the SDK uses) — see .env.example.",
  );
  process.exit(1);
}
const SLACK_TOKEN = SLACK_CHANNEL ? resolveSecret("SLACK_BOT_TOKEN", "SLACK_BOT_OAUTH") : null;
if (SLACK_CHANNEL && !SLACK_TOKEN) {
  console.warn("⚠ SLACK_ALERT_CHANNEL set but no Slack token found — gate alerts disabled.");
}

/** Parse the agent's reply out of the judge step's `item` text (the format the eve hook builds). */
function parseItem(item) {
  const out = { category: "", priority: "", draft_reply: "" };
  if (typeof item !== "string") return out;
  const idx = item.indexOf("TRIAGE RESPONSE:");
  const tri = idx >= 0 ? item.slice(idx) : item;
  const cat = tri.match(/category:\s*(.*)/);
  if (cat) out.category = cat[1].trim();
  const pri = tri.match(/priority:\s*(.*)/);
  if (pri) out.priority = pri[1].trim();
  const dr = tri.match(/draft_reply:\s*([\s\S]*)$/);
  if (dr) out.draft_reply = dr[1].trim();
  return out;
}

/** Parse the judge's full verdict JSON out of raw_result (tolerates fences/prose). */
function parseVerdict(raw) {
  if (typeof raw !== "string") return {};
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end < start) return {};
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return {};
  }
}

const DIM_KEYS = ["empathy", "actionability", "accuracy", "policy"];

/** Flatten a trajectory into a clean row the dashboard renders. Handles both the
 *  simple_judge run shape and the ingest shape. */
function rowFrom(t) {
  const L = Object.fromEntries((t.labels || []).map((l) => [l.key, l.value]));
  const ip = t.init_params || {};
  const ticket = ip.input || {};
  const parsed = parseItem(ip.item);

  // ingest mode keeps the triage in steps.eval.outputs.output; judge mode embeds it in `item`.
  const evalOut = t.steps?.eval?.outputs?.output || null;
  const answer = evalOut?.draft_reply || parsed.draft_reply || "";
  const category = evalOut?.category || parsed.category || "";
  const priority = evalOut?.priority != null ? String(evalOut.priority) : parsed.priority || "";

  const jOut = t.steps?.judge?.outputs || {};
  const result = jOut.results?.[0] || {};
  const verdict = parseVerdict(result.raw_result);
  const explanation = verdict.explanation || result.explanation || "";
  const gradeLabel = "eval.grade" in L ? Number(L["eval.grade"]) : null;
  const gradeStep = jOut.average_score != null ? Number(jOut.average_score) : null;
  const grade = Number.isFinite(gradeLabel) ? gradeLabel : Number.isFinite(gradeStep) ? gradeStep : null;

  // Per-dimension scores: raw_result JSON first, eval.dim.* labels as fallback.
  let dims = null;
  if (verdict.dimensions && typeof verdict.dimensions === "object") {
    dims = {};
    for (const k of DIM_KEYS) {
      const v = Number(verdict.dimensions[k]);
      dims[k] = Number.isFinite(v) ? v : null;
    }
  } else if (DIM_KEYS.some((k) => `eval.dim.${k}` in L)) {
    dims = {};
    for (const k of DIM_KEYS) {
      const v = Number(L[`eval.dim.${k}`]);
      dims[k] = Number.isFinite(v) ? v : null;
    }
  }
  const violation =
    verdict.policy_violation === true || L["eval.policy_violation"] === "true"
      ? true
      : verdict.policy_violation === false || L["eval.policy_violation"] === "false"
        ? false
        : null;

  const pass =
    "eval.pass" in L
      ? L["eval.pass"] === "true"
      : grade != null
        ? grade >= PASS_BAR && violation !== true
        : null;

  return {
    id: t.trajectory_id,
    url: `${UI}/trajectory/${encodeURIComponent(COLLECTION)}/${encodeURIComponent(TASK)}/${encodeURIComponent(t.trajectory_id)}`,
    created: t.created || "",
    status: t.status || "",
    arm: L["eval.config"] || "",
    subject: ticket.subject || "",
    body: ticket.body || "",
    answer,
    category,
    priority,
    grade,
    pass,
    dims,
    violation,
    explanation,
    cost: "cost_est_usd" in L ? Number(L["cost_est_usd"]) : null,
  };
}

/** The release gate: Part 1's verdict, computed live from the labelled runs. */
function computeGate(rows) {
  const perArm = (arm) => {
    const judged = rows.filter((r) => r.arm === arm && r.grade != null && r.pass != null);
    const passes = judged.filter((r) => r.pass).length;
    const costs = judged.filter((r) => r.cost != null);
    return {
      n: judged.length,
      passes,
      rate: judged.length ? passes / judged.length : null,
      avg: judged.length ? judged.reduce((s, r) => s + r.grade, 0) / judged.length : null,
      cost: costs.length ? costs.reduce((s, r) => s + r.cost, 0) / costs.length : null,
      violations: judged.filter((r) => r.violation === true).length,
    };
  };
  const arms = { warm: perArm("warm"), terse: perArm("terse") };
  const ready = arms.warm.n >= GATE_MIN_RUNS && arms.terse.n >= GATE_MIN_RUNS;
  let winner = null;
  let blocked = null;
  if (ready) {
    winner =
      arms.warm.rate > arms.terse.rate
        ? "warm"
        : arms.terse.rate > arms.warm.rate
          ? "terse"
          : arms.warm.avg >= arms.terse.avg
            ? "warm"
            : "terse";
    const loser = winner === "warm" ? "terse" : "warm";
    if (arms[loser].rate < arms[winner].rate) blocked = loser;
  }
  return { ready, minRuns: GATE_MIN_RUNS, bar: PASS_BAR, arms, winner, blocked, alerted: [...alertedArms] };
}

// ---------------------------------------------------------------------------
// Slack: one alert per blocked arm per process — the "the eval paged us" beat.
// ---------------------------------------------------------------------------
const alertedArms = new Set();
const ARM_LABEL = { warm: "v1 (warm)", terse: "v2 (terse)" };
const pct = (x) => (x == null ? "—" : Math.round(x * 100) + "%");

async function maybeAlert(gate) {
  if (!SLACK_TOKEN || !gate.ready || !gate.blocked || alertedArms.has(gate.blocked)) return;
  alertedArms.add(gate.blocked); // set first — never double-post, even if the POST fails
  const b = gate.arms[gate.blocked];
  const w = gate.arms[gate.winner];
  const text =
    `🚦 *eve × Jetty release gate: BLOCK ${ARM_LABEL[gate.blocked]}* — ` +
    `pass ${pct(b.rate)} (${b.passes}/${b.n}) vs ${ARM_LABEL[gate.winner]} ${pct(w.rate)} (${w.passes}/${w.n}), bar ${gate.bar.toFixed(1)}/5` +
    (b.violations ? ` · ${b.violations} policy violation(s)` : "") +
    `\nWinner ships: *${ARM_LABEL[gate.winner]}*. Runs: ${UI}/trajectory/${COLLECTION}/${TASK}`;
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SLACK_TOKEN}` },
      body: JSON.stringify({ channel: SLACK_CHANNEL, text, unfurl_links: false }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || `http ${res.status}`);
    console.log(`🔔 Slack alert posted to ${SLACK_CHANNEL}: gate BLOCKED ${gate.blocked}`);
  } catch (e) {
    console.warn(`slack alert failed: ${e.message}`);
  }
}

let lastJson = "";
const clients = new Set();

async function poll() {
  try {
    const url = `${API}/api/v1/db/trajectories/${encodeURIComponent(COLLECTION)}/${encodeURIComponent(TASK)}?limit=${LIMIT}&page=1`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) throw new Error(`list ${res.status}`);
    const data = await res.json();
    const rows = (data.trajectories || [])
      .map(rowFrom)
      .filter((r) => r.subject || r.body || r.answer)
      .sort((a, b) => String(b.created).localeCompare(String(a.created)));
    const gate = computeGate(rows);
    await maybeAlert(gate);
    const payload = {
      rows,
      gate,
      meta: { collection: COLLECTION, task: TASK, ui: UI, url: `${UI}/trajectory/${COLLECTION}/${TASK}` },
    };
    const json = JSON.stringify(payload);
    if (json !== lastJson) {
      lastJson = json;
      for (const res of clients) res.write(`data: ${json}\n\n`);
    }
  } catch (e) {
    process.stderr.write(`poll error: ${e.message}\n`);
  }
}

const HTML = await readFile(join(__dirname, "public", "index.html"), "utf8");
const PELLY = await readFile(join(__dirname, "public", "pelly.svg"), "utf8");

createServer((req, res) => {
  if (req.url === "/pelly.svg") {
    res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "max-age=3600" });
    res.end(PELLY);
    return;
  }
  if (req.url?.startsWith("/events")) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    res.write("retry: 2000\n\n");
    if (lastJson) res.write(`data: ${lastJson}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(HTML);
}).listen(PORT, () => {
  console.log(
    `🟢 Jetty live monitor → http://localhost:${PORT}   watching ${COLLECTION}/${TASK}` +
      (SLACK_TOKEN ? `   (gate alerts → ${SLACK_CHANNEL})` : ""),
  );
});

setInterval(poll, POLL_MS);
poll();
