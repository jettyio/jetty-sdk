/**
 * Per-turn A/B arm selection for the LIVE demo (`eve dev`) — now a bandit.
 *
 * The batch harness (src/ab-eval.ts) injects the warm/terse style per send from
 * OUTSIDE the agent — it controls every prompt. A live `eve dev` chat has no such
 * driver: a human just types a support request. So the agent picks its own arm on
 * every turn, via eve's dynamic-instructions seam: a resolver that runs server-side
 * on `turn.started` (once per turn, before the model call) and contributes a system
 * message on top of the always-on agent/instructions.md.
 *
 * THE LOOP, CLOSED. The arm is not a coin flip (unless you ask for one): it's
 * Thompson sampling whose reward signal is the live pass-rate **read back from
 * Jetty labels** (`eval.config` / `eval.pass`), the same durable records the
 * ingest hook writes and the monitor charts. Grades steer traffic: as judged runs
 * accumulate, allocation shifts from 50/50 toward the winning arm — Jetty isn't a
 * scoreboard here, it's the reward signal.
 *
 *   JETTY_BANDIT=thompson    (default) explore, then Thompson-sample
 *   JETTY_BANDIT=off         the old fair coin — for a controlled 50/50 experiment
 *   BANDIT_MIN_PER_ARM=5     pure 50/50 until EACH arm has this many judged runs —
 *                            matched to the monitor's GATE_MIN_RUNS, so the bandit
 *                            keeps exploring exactly until the release gate is armed,
 *                            then exploits the winner
 *   BANDIT_WINDOW=60         most-recent runs whose labels count as the posterior
 *   BANDIT_REFRESH_MS=8000   how often stats are re-fetched from Jetty
 *
 * The resolver stays synchronous and fast: it samples from a cached posterior and
 * refreshes the cache in the background (never in the model's critical path). With
 * no JETTY_COLLECTION or an unreachable API it degrades to the fair coin, so the
 * agent dir still runs without Jetty.
 *
 * It records the chosen arm in a Map keyed by eve's `turnId`; the companion hook
 * (agent/hooks/ingest.ts) runs in the SAME `eve dev` process and reads it back on
 * `turn.completed`, so every ingested trajectory is labelled with the arm it
 * actually ran. Allowed dynamic-instruction events are only {session.started,
 * turn.started} — `turn.started` re-resolves the prompt per turn.
 *
 * The two styles mirror CONFIGS in src/tickets.ts. They're inlined here (rather
 * than imported across the src/ boundary) so eve's agent loader stays self-contained.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";
import { JettyClient } from "@jetty/sdk";

export type Arm = "warm" | "terse";

const ARM_STYLE: Record<Arm, string> = {
  warm:
    "write draft_reply as a warm, specific first response: acknowledge the problem, " +
    "give a concrete next step, and match the customer's tier.",
  terse:
    "write draft_reply as a single terse sentence. Do not apologize, do not add steps " +
    "or detail, do not personalize.",
};

/**
 * turnId → arm, shared with the ingest hook. Stored on `globalThis` (not a plain
 * module export) because eve loads each authored module as its own bundle, so a
 * normal `import` would hand the hook a DIFFERENT Map instance than the resolver
 * writes to — and the arm would never reach the ingested trajectory. The global
 * key is the single source of truth both files reach.
 */
const ARM_MAP_KEY = "__eveJettyArmForTurn";
const g = globalThis as Record<string, unknown>;
export const armForTurn: Map<string, Arm> =
  (g[ARM_MAP_KEY] as Map<string, Arm> | undefined) ?? ((g[ARM_MAP_KEY] = new Map<string, Arm>()) as Map<string, Arm>);

// ---------------------------------------------------------------------------
// The bandit: Beta-Bernoulli Thompson sampling over live Jetty pass-rates.
// ---------------------------------------------------------------------------

const BANDIT = process.env.JETTY_BANDIT ?? "thompson"; // "thompson" | "off"
const MIN_PER_ARM = Number(process.env.BANDIT_MIN_PER_ARM ?? 5);
const WINDOW = Math.min(200, Number(process.env.BANDIT_WINDOW ?? 60));
const REFRESH_MS = Number(process.env.BANDIT_REFRESH_MS ?? 8000);
const COLLECTION = process.env.JETTY_COLLECTION ?? "";
const TASK = process.env.JETTY_AGENT_TASK ?? "triage-live";

interface ArmStats {
  passes: number;
  fails: number;
}
const stats: Record<Arm, ArmStats> = {
  warm: { passes: 0, fails: 0 },
  terse: { passes: 0, fails: 0 },
};
const armN = (s: ArmStats): number => s.passes + s.fails;
let lastRefresh = 0;
let refreshing = false;

let client: JettyClient | undefined;
if (COLLECTION && BANDIT !== "off") {
  try {
    client = new JettyClient();
  } catch {
    console.warn("[bandit] no Jetty credentials — falling back to a fair coin.");
  }
}

/** Re-read eval.config / eval.pass labels from the last WINDOW runs (fire-and-forget). */
async function refreshStats(): Promise<void> {
  if (!client || refreshing) return;
  refreshing = true;
  try {
    const res = await client.listTrajectories(COLLECTION, TASK, WINDOW, 1);
    const next: Record<Arm, ArmStats> = { warm: { passes: 0, fails: 0 }, terse: { passes: 0, fails: 0 } };
    for (const t of res.trajectories ?? []) {
      const labels = Object.fromEntries((t.labels ?? []).map((l) => [l.key, l.value]));
      const arm = labels["eval.config"] as Arm | undefined;
      const pass = labels["eval.pass"];
      if ((arm === "warm" || arm === "terse") && (pass === "true" || pass === "false")) {
        next[arm][pass === "true" ? "passes" : "fails"]++;
      }
    }
    stats.warm = next.warm;
    stats.terse = next.terse;
    lastRefresh = Date.now();
  } catch (err) {
    // Keep the last posterior; the bandit degrades gracefully when Jetty is briefly away.
    console.warn(`[bandit] stats refresh failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    refreshing = false;
  }
}

/** Standard normal via Box–Muller. */
function gauss(): number {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

/** Gamma(shape, 1) via Marsaglia–Tsang (with the shape<1 boost). */
function sampleGamma(shape: number): number {
  if (shape < 1) return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = gauss();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleBeta(a: number, b: number): number {
  const x = sampleGamma(a);
  const y = sampleGamma(b);
  return x / (x + y);
}

const coin = (): Arm => (Math.random() < 0.5 ? "warm" : "terse");

/** Pick this turn's arm from the cached posterior (sync — never blocks the turn). */
function pickArm(): Arm {
  if (!client || BANDIT === "off") return coin();
  if (Date.now() - lastRefresh > REFRESH_MS) void refreshStats();
  if (armN(stats.warm) < MIN_PER_ARM || armN(stats.terse) < MIN_PER_ARM) {
    console.log(
      `[bandit] exploring (warm ${armN(stats.warm)}/${MIN_PER_ARM}, ` +
        `terse ${armN(stats.terse)}/${MIN_PER_ARM} judged) → 50/50`,
    );
    return coin();
  }
  const w = sampleBeta(1 + stats.warm.passes, 1 + stats.warm.fails);
  const t = sampleBeta(1 + stats.terse.passes, 1 + stats.terse.fails);
  const arm: Arm = w >= t ? "warm" : "terse";
  console.log(
    `[bandit] thompson warm ${stats.warm.passes}/${stats.warm.passes + stats.warm.fails} ` +
      `terse ${stats.terse.passes}/${stats.terse.passes + stats.terse.fails} ` +
      `(draw ${w.toFixed(2)} vs ${t.toFixed(2)}) → ${arm}`,
  );
  return arm;
}

// Warm the posterior at load so the first turn already sees history.
void refreshStats();

export default defineDynamic({
  events: {
    "turn.started": (event) => {
      const turnId = (event as { data?: { turnId?: string } }).data?.turnId ?? "";
      const arm = pickArm();
      if (turnId) armForTurn.set(turnId, arm);
      return defineInstructions({
        markdown:
          `For THIS reply, ${ARM_STYLE[arm]}\n\n` +
          `Respond with ONLY the triage JSON object ` +
          `{ "category": string, "priority": number (1=highest..5=lowest), "draft_reply": string } ` +
          `— no prose, no code fences.`,
      });
    },
  },
});
