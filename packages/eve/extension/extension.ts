/**
 * @jetty/eve — the Jetty live-eval extension for eve agents.
 *
 * Mount it under `agent/extensions/` and the consuming agent gains, under the
 * mount's namespace:
 *
 *   - hooks/ingest        every finished turn lands in Jetty as a durable,
 *                         labelled trajectory (or is judged inline by a native
 *                         Jetty `simple_judge` task, `judgeMode: "simple_judge"`)
 *   - instructions/arm    a per-turn dynamic-instructions resolver that runs an
 *                         episodic Thompson-sampling bandit over the configured
 *                         reply-style `arms`, rewarded by the pass-rates read
 *                         back from Jetty labels
 *   - tools/experiment    a tool the model can call to report the live
 *                         experiment status (per-arm pass rates + leader)
 *
 * Config binds once at the mount site (`export default jetty({ ... })`) and is
 * read everywhere else via `extension.config`. With an empty `collection` the
 * extension degrades to a no-op (fair-coin styles, no ingest), so the consuming
 * agent still runs without Jetty credentials.
 *
 * Cross-module bookkeeping (which arm a turn ran, the turn's captured
 * input/reply/usage) lives in `defineState` (extension/lib/state.ts) — durable,
 * session-scoped, and auto-namespaced to this package, so it never collides
 * with the consuming agent's own state.
 */
import { defineExtension } from "eve/extension";
import { z } from "zod";

export default defineExtension({
  config: z.object({
    /** Jetty collection to write trajectories under. Empty → extension no-ops. */
    collection: z.string().default(""),
    /** Jetty task the live turns are ingested under (and, in `simple_judge` mode, run against). */
    task: z.string().default("live-eval"),
    /** Author recorded on ingested trajectories and labels. */
    author: z.string().default("eve-dev@jetty.example"),
    /**
     * "ingest" (default): write a finished, ungraded trajectory per turn — an
     * out-of-band grader scores it later. "simple_judge": run `task` as a native
     * Jetty simple_judge workflow per turn and label its score inline.
     */
    judgeMode: z.enum(["ingest", "simple_judge"]).default("ingest"),
    /** Minimum judge score (1–5) for `eval.pass=true` in simple_judge mode. */
    passBar: z.number().default(3),
    /**
     * The experiment arms: arm name → the style instruction injected for turns
     * that play that arm. Arm names become `eval.config` label values. Empty →
     * no per-turn style injection (the contract line, if any, still applies).
     */
    arms: z.record(z.string(), z.string()).default({}),
    /** Always-appended per-turn reply contract (e.g. "respond with ONLY this JSON …"). */
    contract: z.string().default(""),
    /** "thompson" (default): episodic Thompson sampling over live Jetty pass-rates. "off": fair coin. */
    bandit: z.enum(["thompson", "off"]).default("thompson"),
    /** Explore (round-robin) until EACH arm has this many judged runs, then exploit. */
    banditMinPerArm: z.number().int().positive().default(5),
    /** Turns per episode — the bandit commits to one arm this long before re-sampling. */
    banditEpisodeLen: z.number().int().positive().default(3),
    /** Most-recent runs whose labels form the posterior. */
    banditWindow: z.number().int().positive().max(200).default(60),
    /** How often (ms) arm stats are re-fetched from Jetty. */
    banditRefreshMs: z.number().positive().default(8000),
    /** USD per 1M input tokens — used to estimate `cost_est_usd` (eve reports tokens, not dollars). */
    priceInPerMTok: z.number().nonnegative().default(3),
    /** USD per 1M output tokens. */
    priceOutPerMTok: z.number().nonnegative().default(15),
  }),
});
