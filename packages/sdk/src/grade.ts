/**
 * `gradeWithJetty` — the eval primitive.
 *
 * Run, check, fix, rerun: an agent (Flue, or anything) produces an output, and
 * an *independent* Jetty grading task scores it. This helper collapses that into
 * one call: upload the output, run the grader to completion, read its grade
 * file, and label the resulting trajectory. The returned {@link Trajectory} is
 * the durable, comparable eval record — score and cost live on its labels.
 *
 * The grader is a Jetty task you deploy once (a deterministic rubric or an LLM
 * judge). It isn't the agent scoring itself, which rubber-stamps.
 *
 * @module
 */
import type { JettyClient } from "./client.js";
import { JettyError } from "./errors.js";
import type { JettyFile, RunAndWaitOptions, Trajectory } from "./types.js";

/** Labels to attach to the grading trajectory, or a function of the grade. */
export type GradeLabels<G> =
  | Record<string, string>
  | ((grade: G) => Record<string, string>);

/** Options for {@link gradeWithJetty}. Extends {@link RunAndWaitOptions}. */
export interface GradeOptions<G = unknown> extends Omit<RunAndWaitOptions, "files"> {
  /** The output(s) to grade, uploaded as files on the grading run. Required. */
  files: JettyFile[];
  /** `init_params` for the grading task. Default `{}`. */
  initParams?: Record<string, unknown>;
  /**
   * Which result file holds the grade: a filename suffix to match
   * (default `"grade.json"`) or a predicate over each file's storage key.
   */
  gradeFile?: string | ((key: string) => boolean);
  /** Parse the downloaded grade bytes. Default: `JSON.parse` of the UTF-8 text. */
  parseGrade?: (bytes: Uint8Array) => G;
  /**
   * Labels to attach once the trajectory completes — a static map, or a function
   * of the parsed grade (so you can label `eval.grade` with the score itself).
   */
  labels?: GradeLabels<G>;
  /** Author recorded on the labels. Default `"jetty-sdk"`. */
  author?: string;
}

/** What {@link gradeWithJetty} resolves to. */
export interface GradeResult<G = unknown> {
  /** The grading run's trajectory id — poll, label, or open it via this. */
  trajectoryId: string;
  /** The parsed grade (default: the JSON in the grade file). */
  grade: G;
  /** Storage key of the grade file that was read. */
  gradeKey: string;
  /** The full completed trajectory: inputs, outputs, steps, labels, replayable. */
  trajectory: Trajectory;
}

const decodeJson = <G>(bytes: Uint8Array): G =>
  JSON.parse(new TextDecoder().decode(bytes)) as G;

/** Pull the result-file storage keys off a completed trajectory's `run` step. */
function resultFileKeys(trajectory: Trajectory): string[] {
  const outputs = (trajectory.steps?.run?.outputs ?? {}) as Record<string, unknown>;
  const files = (outputs.files ?? outputs.results_files ?? []) as unknown[];
  return files
    .map((f) => (typeof f === "string" ? f : (f as { path?: string }).path))
    .filter((k): k is string => typeof k === "string");
}

/**
 * Grade an agent output with a Jetty grading task, in one call.
 *
 * @example
 * ```ts
 * import { JettyClient, gradeWithJetty } from "@jetty/sdk";
 *
 * const jetty = new JettyClient();
 * const { grade, trajectoryId } = await gradeWithJetty<{ total: number; pass: boolean }>(
 *   jetty,
 *   "acme",
 *   "triage-grader",
 *   {
 *     files: [{ filename: "case.json", data: JSON.stringify({ ticket, triage }) }],
 *     useTrialKeys: true,                       // grade on Jetty's free trial
 *     labels: (g) => ({                         // labels can read the grade
 *       "eval.config": "v1",
 *       "eval.grade": g.total.toFixed(2),
 *       "eval.pass": String(g.pass),
 *     }),
 *   },
 * );
 * // open the durable record at https://flows.jetty.io/acme/triage-grader/<trajectoryId>
 * ```
 *
 * @throws {JettyError} if the grader produces no matching grade file.
 * @throws {JettyRunFailedError} if the grading run fails/cancels (via `runAndWait`).
 * @throws {JettyTimeoutError} if the wait budget is exceeded (via `runAndWait`).
 */
export async function gradeWithJetty<G = unknown>(
  client: JettyClient,
  collection: string,
  task: string,
  options: GradeOptions<G>,
): Promise<GradeResult<G>> {
  const {
    files,
    initParams = {},
    gradeFile = "grade.json",
    parseGrade = decodeJson<G>,
    labels,
    author = "jetty-sdk",
    ...runOpts
  } = options;

  const trajectory = await client.runAndWait(collection, task, initParams, {
    ...runOpts,
    files,
  });

  const keys = resultFileKeys(trajectory);
  const matches =
    typeof gradeFile === "function" ? gradeFile : (k: string) => k.endsWith(gradeFile);
  const gradeKey = keys.find(matches);
  if (!gradeKey) {
    const looking =
      typeof gradeFile === "string" ? `a file ending in "${gradeFile}"` : "a custom file match";
    throw new JettyError(
      `Grading task ${collection}/${task} produced no grade file (wanted ${looking}; ` +
        `result files: ${keys.join(", ") || "none"}).`,
    );
  }

  const { bytes } = await client.downloadFile(gradeKey);
  const grade = parseGrade(bytes);

  if (labels) {
    const resolved = typeof labels === "function" ? labels(grade) : labels;
    for (const [key, value] of Object.entries(resolved)) {
      await client.addLabel(collection, task, trajectory.trajectory_id, key, value, author);
    }
  }

  return { trajectoryId: trajectory.trajectory_id, grade, gradeKey, trajectory };
}
