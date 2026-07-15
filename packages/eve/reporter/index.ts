/**
 * `Jetty()` — a native eve eval reporter.
 *
 * Drops into `evals.config.ts` (or a single `defineEval`) exactly where eve's
 * built-in `Braintrust(...)` reporter goes. eve runs the eval; this reporter
 * pushes each result into Jetty as a durable, labelled trajectory — so a prompt
 * or model change shows up as a diff-able row in your Jetty scoreboard, not a
 * number that scrolls off the terminal.
 *
 *   // evals/evals.config.ts
 *   import { defineEvalConfig } from "eve/evals";
 *   import { Jetty } from "@jetty/eve/reporter";
 *   export default defineEvalConfig({ reporters: [Jetty()] });
 *
 * It's the `eve eval`-side counterpart to the mounted extension: the extension
 * makes Jetty the independent *grader* of live turns; this reporter makes Jetty
 * the durable *scoreboard* for eve's own scores. No OpenTelemetry, no trace
 * pipeline — eve's per-eval scores are pushed straight to a single ingest call.
 *
 * (Reporters are eval-runner config, not an agent capability, so this ships as
 * a plain package export rather than an extension contribution.)
 *
 * Requires `JETTY_API_TOKEN` (+ `JETTY_COLLECTION`). Point it at a local mise
 * with `JETTY_API_URL=http://localhost:8000`. The reporter never fails an eval
 * run: if Jetty is unreachable it logs a warning and the run continues.
 */
import { JettyClient, type IngestTrajectoryPayload } from "@jetty/sdk";
import type { EvalReporter } from "eve/evals/reporters";
import type { EveEval, EveEvalResult, EveEvalRunSummary, EveEvalTarget } from "eve/evals";

export interface JettyReporterConfig {
  /** Jetty collection to write trajectories under. Default: `JETTY_COLLECTION`. */
  collection?: string;
  /** Flow/task name the eval runs are grouped under. Default: `JETTY_PROJECT` or `"eve-evals"`. */
  project?: string;
  /** Author recorded on the trajectories and labels. Default `"eve-eval"`. */
  author?: string;
  /** Inject a pre-built client (tests/proxies). Default: `new JettyClient()`. */
  client?: JettyClient;
}

/** Create a `Jetty()` eve eval reporter. See {@link JettyReporterConfig}. */
export function Jetty(config: JettyReporterConfig = {}): EvalReporter {
  return new JettyReporter(config);
}

class JettyReporter implements EvalReporter {
  private readonly config: JettyReporterConfig;
  private client: JettyClient | undefined;
  private collection = "";
  private project = "eve-evals";
  private author = "eve-eval";
  private disabled = false;
  private ingested = 0;

  constructor(config: JettyReporterConfig) {
    this.config = config;
  }

  onRunStart(_evaluations: readonly EveEval[], _target: EveEvalTarget): void {
    this.collection = this.config.collection ?? process.env.JETTY_COLLECTION ?? "";
    this.project = this.config.project ?? process.env.JETTY_PROJECT ?? "eve-evals";
    this.author = this.config.author ?? "eve-eval";

    if (!this.collection) {
      this.disabled = true;
      console.warn(
        "[jetty-reporter] No collection set (config.collection or JETTY_COLLECTION); skipping Jetty reporting.",
      );
      return;
    }
    try {
      this.client = this.config.client ?? new JettyClient();
    } catch (err) {
      this.disabled = true;
      console.warn(
        `[jetty-reporter] Could not construct JettyClient; skipping Jetty reporting: ${msg(err)}`,
      );
    }
  }

  async onEvalComplete(result: EveEvalResult): Promise<void> {
    if (this.disabled || !this.client) return;

    const scores: Record<string, number> = {};
    for (const assertion of result.assertions) scores[assertion.name] = assertion.score;

    const labels: Record<string, string> = {
      "eve.verdict": result.verdict,
      "eve.status": result.result.status,
    };
    if (result.error) labels["eve.error"] = result.error.slice(0, 280);

    const payload: IngestTrajectoryPayload = {
      // The eve session id makes a re-run of the same session idempotent.
      trajectory_id: result.result.sessionId,
      eval_id: result.id,
      output: result.result.output,
      status: result.verdict === "failed" ? "failed" : "completed",
      scores,
      labels,
      source: "eve",
      author: this.author,
      metadata: { eveSessionId: result.result.sessionId, evalId: result.id },
      created: result.startedAt,
      completed: result.completedAt,
    };

    try {
      const { trajectory_id } = await this.client.ingestTrajectory(
        this.collection,
        this.project,
        payload,
      );
      this.ingested++;
      console.log(`[jetty-reporter] ${result.id} → ${this.collection}/${this.project} (${trajectory_id})`);
    } catch (err) {
      console.warn(`[jetty-reporter] Failed to ingest eval "${result.id}": ${msg(err)}`);
    }
  }

  onRunComplete(summary: EveEvalRunSummary): void {
    if (this.disabled) return;
    console.log(
      `[jetty-reporter] Ingested ${this.ingested} eval result(s) into ` +
        `${this.collection}/${this.project} ` +
        `(${summary.passed} passed, ${summary.failed} failed).`,
    );
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
