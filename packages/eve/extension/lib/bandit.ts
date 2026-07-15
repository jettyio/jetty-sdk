/**
 * The bandit: EPISODIC Beta-Bernoulli Thompson sampling over live Jetty pass-rates.
 *
 * `pickArm()` stays synchronous and fast — the dynamic-instructions resolver
 * calls it once per turn, before the model call, and must never block the chat.
 * It samples from a cached posterior and refreshes the cache in the background.
 * The reward signal is the live pass-rate read back from Jetty labels
 * (`eval.config` / `eval.pass`) — the same durable records the ingest hook
 * writes. Grades steer traffic: Jetty isn't a scoreboard here, it's the reward.
 *
 * Episodic: the bandit commits to one arm for `banditEpisodeLen` turns, then
 * re-samples. It explores (round-robin the least-judged arm) until EACH arm has
 * `banditMinPerArm` judged runs, then exploits by Thompson-sampling the winner.
 * With `bandit: "off"` (or no usable Jetty client) it degrades to a fair coin.
 */
import extension from "../extension";
import { jettyClient, msg } from "./jetty";

export interface ArmStats {
  passes: number;
  fails: number;
}

const armN = (s: ArmStats): number => s.passes + s.fails;

/**
 * Read per-arm judged-run counts back from the last `window` runs' labels.
 * Shared by the bandit's posterior refresh and the `experiment` tool.
 */
export async function readArmStats(
  arms: readonly string[],
  window: number,
): Promise<Record<string, ArmStats> | undefined> {
  const jetty = jettyClient();
  if (!jetty) return undefined;
  const { collection, task } = extension.config;
  const res = await jetty.listTrajectories(collection, task, window, 1);
  const stats: Record<string, ArmStats> = Object.fromEntries(
    arms.map((a) => [a, { passes: 0, fails: 0 }]),
  );
  for (const t of res.trajectories ?? []) {
    const labels = Object.fromEntries((t.labels ?? []).map((l) => [l.key, l.value]));
    const arm = labels["eval.config"];
    const pass = labels["eval.pass"];
    if (arm && arm in stats && (pass === "true" || pass === "false")) {
      stats[arm][pass === "true" ? "passes" : "fails"]++;
    }
  }
  return stats;
}

// Posterior cache — module-local is fine here: only this contribution's bundle
// reads it (cross-contribution turn state lives in lib/state.ts instead).
let stats: Record<string, ArmStats> = {};
let lastRefresh = 0;
let refreshing = false;
// Episode state: the arm committed for the current episode, and turns left before re-sampling.
let episodeArm: string | null = null;
let episodeTurnsLeft = 0;
// Episodes assigned per arm — used to rotate exploration evenly even before grades land.
const episodesFor: Record<string, number> = {};

/** Re-read the posterior from Jetty labels (fire-and-forget). */
function refreshStats(arms: readonly string[]): void {
  if (refreshing) return;
  refreshing = true;
  void readArmStats(arms, extension.config.banditWindow)
    .then((next) => {
      if (next) {
        stats = next;
        lastRefresh = Date.now();
      }
    })
    .catch((err: unknown) => {
      // Keep the last posterior; the bandit degrades gracefully when Jetty is briefly away.
      console.warn(`[@jetty/eve] bandit stats refresh failed: ${msg(err)}`);
    })
    .finally(() => {
      refreshing = false;
    });
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

const coin = (arms: readonly string[]): string => arms[Math.floor(Math.random() * arms.length)];

const statsFor = (arm: string): ArmStats => stats[arm] ?? { passes: 0, fails: 0 };

/** Choose the arm for a fresh episode: round-robin the least-judged arm while exploring,
 *  then Thompson-sample one arm to exploit for the whole episode. */
function chooseEpisodeArm(arms: readonly string[]): string {
  const { banditMinPerArm, banditEpisodeLen } = extension.config;
  // Explore: while any arm has < banditMinPerArm judged runs, give the episode to the
  // least-judged arm so every arm fills up evenly.
  const under = arms.filter((a) => armN(statsFor(a)) < banditMinPerArm);
  if (under.length) {
    // Fewest episodes assigned so far → even round-robin regardless of grade lag.
    const arm = under.reduce(
      (lo, a) => ((episodesFor[a] ?? 0) < (episodesFor[lo] ?? 0) ? a : lo),
      under[0],
    );
    console.log(
      `[@jetty/eve] new episode → explore ${arm} (${arms.map((a) => `${a} ${armN(statsFor(a))}/${banditMinPerArm}`).join(", ")})`,
    );
    return arm;
  }
  // Exploit: draw a pass-rate from each arm's Beta posterior and commit the argmax.
  const draws = arms.map((a) => ({
    a,
    x: sampleBeta(1 + statsFor(a).passes, 1 + statsFor(a).fails),
  }));
  const arm = draws.reduce((best, d) => (d.x > best.x ? d : best)).a;
  console.log(
    `[@jetty/eve] new episode → exploit ${arm} for ${banditEpisodeLen} turn(s) ` +
      `(${arms.map((a) => `${a} ${statsFor(a).passes}/${armN(statsFor(a))}`).join(" ")}; draws ${draws.map((d) => d.x.toFixed(2)).join("/")})`,
  );
  return arm;
}

/** Pick this turn's arm (sync — never blocks the turn). Episodic: the same arm is played
 *  for `banditEpisodeLen` turns, then the posterior is re-sampled for the next episode. */
export function pickArm(arms: readonly string[]): string {
  const { bandit, banditRefreshMs, banditEpisodeLen } = extension.config;
  if (bandit === "off" || !jettyClient()) return coin(arms); // controlled fair coin, per turn
  if (Date.now() - lastRefresh > banditRefreshMs) refreshStats(arms);
  if (episodeArm && arms.includes(episodeArm) && episodeTurnsLeft > 0) {
    episodeTurnsLeft--;
    return episodeArm; // mid-episode: stay on the committed arm
  }
  // New episode: pull the latest grades, then choose and commit an arm.
  refreshStats(arms);
  episodeArm = chooseEpisodeArm(arms);
  episodesFor[episodeArm] = (episodesFor[episodeArm] ?? 0) + 1;
  episodeTurnsLeft = banditEpisodeLen - 1; // this turn is the episode's first
  return episodeArm;
}
