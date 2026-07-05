/**
 * Pure trajectory→row/gate logic for the serverless dashboard.
 *
 * Mirrors the flattening in ../../monitor/server.mjs (the local SSE monitor), minus the
 * long-lived polling loop and the in-process Slack de-dup — those need a persistent
 * process / shared state, which a per-request Vercel function doesn't have. Everything
 * here is stateless: given a Jetty trajectory list + config, it returns the same
 * `{ rows, gate, meta }` payload the browser already knows how to render.
 */

const DIM_KEYS = ["empathy", "actionability", "accuracy", "policy"];

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

/** Flatten a trajectory into a clean row the dashboard renders (simple_judge or ingest shape). */
function rowFrom(t, cfg) {
  const { UI, COLLECTION, TASK, PASS_BAR } = cfg;
  const L = Object.fromEntries((t.labels || []).map((l) => [l.key, l.value]));
  const ip = t.init_params || {};
  const ticket = ip.input || {};
  const parsed = parseItem(ip.item);

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

/** The release gate, computed from the labelled runs. Stateless: no Slack alert here. */
function computeGate(rows, { GATE_MIN_RUNS, PASS_BAR }) {
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
  // `alerted` kept for payload-shape parity with the local monitor (the client reads it).
  return { ready, minRuns: GATE_MIN_RUNS, bar: PASS_BAR, arms, winner, blocked, alerted: [] };
}

/** Build the `{ rows, gate, meta }` payload from a Jetty trajectory-list response + env. */
export function buildPayload(data, env) {
  const UI = env.JETTY_UI_URL || "https://jetty.io";
  const COLLECTION = env.JETTY_COLLECTION || "jetty-vercel-demo";
  const TASK = env.JETTY_AGENT_TASK || "triage-live";
  // Arm the gate at the same count the agent's bandit stops exploring — see the local monitor.
  const GATE_MIN_RUNS = Number(env.GATE_MIN_RUNS || env.BANDIT_MIN_PER_ARM || 5);
  const PASS_BAR = 4.0;
  const cfg = { UI, COLLECTION, TASK, PASS_BAR };

  const rows = (data.trajectories || [])
    .map((t) => rowFrom(t, cfg))
    .filter((r) => r.subject || r.body || r.answer)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
  const gate = computeGate(rows, { GATE_MIN_RUNS, PASS_BAR });
  return {
    rows,
    gate,
    meta: { collection: COLLECTION, task: TASK, ui: UI, url: `${UI}/trajectory/${COLLECTION}/${TASK}` },
  };
}
