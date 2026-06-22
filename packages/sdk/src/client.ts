import {
  DEFAULT_TOKEN_FILE,
  resolveConfig,
  missingTokenMessage,
  type JettyConfig,
} from "./config.js";
import { JettyConfigError, JettyError, JettyRunFailedError, JettyTimeoutError } from "./errors.js";
import { HttpClient, type FetchLike } from "./http.js";
import { parseWorkflowId } from "./poll.js";
import type {
  Collection,
  JettyFile,
  RunAndWaitOptions,
  RunOptions,
  StepTemplate,
  Task,
  Trajectory,
  TrajectoryListResponse,
  WorkflowResponse,
} from "./types.js";

export interface JettyClientOptions extends JettyConfig {
  /** Per-request timeout in ms. Default 60_000. */
  timeoutMs?: number;
  /** Max retries on transient failures (network + 5xx, never 524). Default 2. */
  maxRetries?: number;
  /** Injectable fetch (defaults to global fetch; useful for tests/proxies). */
  fetch?: FetchLike;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Typed, thin client over the Jetty REST API.
 *
 * Auth + base URL resolve from (in order) constructor args → environment →
 * `~/.config/jetty/token`. Construction throws a clear, source-naming error if
 * no token can be found.
 *
 * @example
 * ```ts
 * const jetty = new JettyClient();                  // token from env or token file
 * const run = await jetty.runAndWait("acme", "triage", { ticket });
 * const { category } = run.steps.triage.outputs;
 * ```
 */
export class JettyClient {
  /** Resolved API base URL. */
  readonly apiUrl: string;
  private readonly token: string;
  private readonly http: HttpClient;

  constructor(options: JettyClientOptions = {}) {
    const resolved = resolveConfig(options);
    this.apiUrl = resolved.apiUrl;
    if (!resolved.token) {
      throw new JettyConfigError(missingTokenMessage(options.tokenFile ?? DEFAULT_TOKEN_FILE));
    }
    this.token = resolved.token;
    this.http = new HttpClient({
      apiUrl: this.apiUrl,
      getToken: () => this.token,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      fetch: options.fetch,
    });
  }

  /** Escape a single path segment so slashes/spaces in names don't break URLs. */
  private seg(value: string): string {
    return encodeURIComponent(value);
  }

  // ---------------------------------------------------------------------------
  // Collections
  // ---------------------------------------------------------------------------

  listCollections(): Promise<Collection[]> {
    return this.http.request("/api/v1/collections/");
  }

  getCollection(collection: string): Promise<Collection> {
    return this.http.request(`/api/v1/collections/${this.seg(collection)}`);
  }

  getCollectionEnvironment(collection: string): Promise<Record<string, unknown>> {
    return this.http.request(`/api/v1/collections/${this.seg(collection)}/environment`);
  }

  setEnvironmentVars(
    collection: string,
    vars: Record<string, string>,
  ): Promise<unknown> {
    return this.http.request(`/api/v1/collections/${this.seg(collection)}/environment`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environment_variables: vars }),
    });
  }

  // ---------------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------------

  listTasks(collection: string): Promise<Task[]> {
    return this.http.request(`/api/v1/tasks/${this.seg(collection)}/`);
  }

  getTask(collection: string, task: string): Promise<Task> {
    return this.http.request(`/api/v1/tasks/${this.seg(collection)}/${this.seg(task)}`);
  }

  createTask(
    collection: string,
    name: string,
    workflow: unknown,
    description?: string,
  ): Promise<Task> {
    return this.http.request(`/api/v1/tasks/${this.seg(collection)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: description ?? "", workflow }),
    });
  }

  updateTask(
    collection: string,
    task: string,
    updates: { workflow?: unknown; description?: string },
  ): Promise<Task> {
    return this.http.request(`/api/v1/tasks/${this.seg(collection)}/${this.seg(task)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
  }

  deleteTask(collection: string, task: string): Promise<unknown> {
    return this.http.request(`/api/v1/tasks/${this.seg(collection)}/${this.seg(task)}`, {
      method: "DELETE",
    });
  }

  // ---------------------------------------------------------------------------
  // Trial keys
  // ---------------------------------------------------------------------------

  getTrialStatus(collection: string): Promise<unknown> {
    return this.http.request(`/api/v1/trial/${this.seg(collection)}`);
  }

  activateTrial(collection: string): Promise<unknown> {
    return this.http.request(`/api/v1/trial/${this.seg(collection)}/activate`, {
      method: "POST",
    });
  }

  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------

  /** Build the multipart body shared by run / runWithFiles. */
  private buildRunForm(
    initParams: Record<string, unknown> | undefined,
    opts: RunOptions | undefined,
    files?: JettyFile[],
  ): FormData {
    const form = new FormData();
    form.append("init_params", JSON.stringify(initParams ?? {}));
    if (opts?.useTrialKeys) form.append("use_trial_keys", "true");
    if (opts?.secretParams) form.append("secret_params", JSON.stringify(opts.secretParams));
    if (opts?.subscriptionCredential) {
      form.append("subscription_credential", opts.subscriptionCredential);
    }
    if (opts?.webhookUrl) form.append("webhook_url", opts.webhookUrl);
    if (opts?.webhookSecret) form.append("webhook_secret", opts.webhookSecret);
    if (files) {
      for (const f of files) {
        let blob: Blob;
        if (f.data instanceof Blob) {
          blob = f.data;
        } else if (typeof f.data === "string" || f.data instanceof ArrayBuffer) {
          blob = new Blob([f.data], { type: f.contentType });
        } else {
          // ArrayBufferView (Buffer / typed array / DataView) → byte view
          const v = f.data;
          blob = new Blob([new Uint8Array(v.buffer, v.byteOffset, v.byteLength)], {
            type: f.contentType,
          });
        }
        form.append("files", blob, f.filename);
      }
    }
    return form;
  }

  /**
   * Start an async run. Returns immediately with a {@link WorkflowResponse}
   * whose `workflow_id` you can poll (or use {@link runAndWait}).
   */
  runWorkflow(
    collection: string,
    task: string,
    initParams?: Record<string, unknown>,
    useTrialKeys?: boolean,
    opts?: RunOptions,
  ): Promise<WorkflowResponse> {
    const form = this.buildRunForm(initParams, { useTrialKeys, ...opts });
    return this.http.request(`/api/v1/run/${this.seg(collection)}/${this.seg(task)}`, {
      method: "POST",
      body: form,
    });
  }

  /**
   * Synchronous run — the server holds the connection until the workflow
   * finishes. Beware: runs longer than ~100s return a Cloudflare 524 (surfaced
   * as `JettyInProgressError`). Prefer {@link runAndWait} for anything slow.
   */
  runWorkflowSync(
    collection: string,
    task: string,
    initParams?: Record<string, unknown>,
    useTrialKeys?: boolean,
    opts?: RunOptions,
  ): Promise<WorkflowResponse> {
    const form = this.buildRunForm(initParams, { useTrialKeys, ...opts });
    return this.http.request(`/api/v1/run-sync/${this.seg(collection)}/${this.seg(task)}`, {
      method: "POST",
      body: form,
    });
  }

  /**
   * Start an async run with file uploads (multipart). Uploaded files land at
   * `trajectory.init_params.file_paths[N]` — wire your `step_configs` to
   * `file_paths`, not `init_params.<name>`.
   */
  runWithFiles(
    collection: string,
    task: string,
    initParams: Record<string, unknown> | undefined,
    files: JettyFile[],
    opts?: RunOptions,
  ): Promise<WorkflowResponse> {
    const form = this.buildRunForm(initParams, opts, files);
    return this.http.request(`/api/v1/run/${this.seg(collection)}/${this.seg(task)}`, {
      method: "POST",
      body: form,
    });
  }

  /**
   * Start an async run and poll its trajectory until it reaches a terminal
   * status. Resolves with the completed {@link Trajectory}; throws
   * {@link JettyRunFailedError} on failed/cancelled/archived and
   * {@link JettyTimeoutError} if the wait budget is exceeded.
   */
  async runAndWait(
    collection: string,
    task: string,
    initParams?: Record<string, unknown>,
    options: RunAndWaitOptions = {},
  ): Promise<Trajectory> {
    const pollMs = options.pollMs ?? 2000;
    const timeoutMs = options.timeoutMs ?? 1_800_000;
    const { pollMs: _p, timeoutMs: _t, onPoll: _o, files, ...runOpts } = options;

    const started = files?.length
      ? await this.runWithFiles(collection, task, initParams, files, runOpts)
      : await this.runWorkflow(collection, task, initParams, runOpts.useTrialKeys, runOpts);
    if (!started.workflow_id) {
      throw new JettyError("Run did not return a workflow_id; cannot poll for completion.");
    }
    const { trajectoryId } = parseWorkflowId(started.workflow_id);

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const trajectory = await this.getTrajectory(collection, task, trajectoryId);
      options.onPoll?.(trajectory);

      if (trajectory.status === "completed") return trajectory;
      if (
        trajectory.status === "failed" ||
        trajectory.status === "cancelled" ||
        trajectory.status === "archived"
      ) {
        throw new JettyRunFailedError(
          trajectory.status,
          trajectory.error ?? undefined,
          trajectoryId,
        );
      }
      if (Date.now() >= deadline) {
        throw new JettyTimeoutError(
          `runAndWait timed out after ${timeoutMs}ms waiting for ` +
            `${collection}/${task} (trajectory ${trajectoryId}); last status="${trajectory.status}".`,
        );
      }
      await sleep(pollMs);
    }
  }

  // ---------------------------------------------------------------------------
  // Trajectories
  // ---------------------------------------------------------------------------

  listTrajectories(
    collection: string,
    task: string,
    limit = 10,
    page = 1,
  ): Promise<TrajectoryListResponse> {
    return this.http.request(
      `/api/v1/db/trajectories/${this.seg(collection)}/${this.seg(task)}?limit=${limit}&page=${page}`,
    );
  }

  getTrajectory(collection: string, task: string, trajectoryId: string): Promise<Trajectory> {
    return this.http.request(
      `/api/v1/db/trajectory/${this.seg(collection)}/${this.seg(task)}/${this.seg(trajectoryId)}`,
    );
  }

  getStats(collection: string, task: string): Promise<unknown> {
    return this.http.request(`/api/v1/db/stats/${this.seg(collection)}/${this.seg(task)}`);
  }

  // ---------------------------------------------------------------------------
  // Labels
  // ---------------------------------------------------------------------------

  addLabel(
    collection: string,
    task: string,
    trajectoryId: string,
    key: string,
    value: string,
    author: string,
  ): Promise<unknown> {
    return this.http.request(
      `/api/v1/trajectory/${this.seg(collection)}/${this.seg(task)}/${this.seg(trajectoryId)}/labels`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value, author }),
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------

  /**
   * Download a result file's bytes by its storage key. The collection is
   * inferred server-side from the key prefix. Honors Content-Disposition for
   * the returned filename.
   */
  downloadFile(storageKey: string): Promise<import("./http.js").BytesResponse> {
    // storageKey may contain slashes; encode each segment, keep the slashes.
    const encoded = storageKey.split("/").map((s) => this.seg(s)).join("/");
    return this.http.requestBytes(`/api/v1/file/${encoded}`);
  }

  // ---------------------------------------------------------------------------
  // Workflow logs
  // ---------------------------------------------------------------------------

  getWorkflowLogs(workflowId: string): Promise<unknown> {
    return this.http.request(`/api/v1/workflows-logs/${this.seg(workflowId)}`);
  }

  // ---------------------------------------------------------------------------
  // Step templates
  // ---------------------------------------------------------------------------

  listStepTemplates(): Promise<StepTemplate[]> {
    return this.http.request("/api/v1/step-templates");
  }

  getStepTemplate(name: string): Promise<StepTemplate> {
    return this.http.request(`/api/v1/step-templates/${this.seg(name)}`);
  }

  // ---------------------------------------------------------------------------
  // Routines (scheduled runs)
  // ---------------------------------------------------------------------------

  listRoutines(collection: string, task?: string): Promise<unknown> {
    const path = task
      ? `/api/v1/routines/${this.seg(collection)}/${this.seg(task)}`
      : `/api/v1/routines/${this.seg(collection)}`;
    return this.http.request(path);
  }

  getRoutine(collection: string, task: string, name: string): Promise<unknown> {
    return this.http.request(
      `/api/v1/routines/${this.seg(collection)}/${this.seg(task)}/${this.seg(name)}`,
    );
  }

  createRoutine(
    collection: string,
    task: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.http.request(`/api/v1/routines/${this.seg(collection)}/${this.seg(task)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  updateRoutine(
    collection: string,
    task: string,
    name: string,
    patch: Record<string, unknown>,
  ): Promise<unknown> {
    return this.http.request(
      `/api/v1/routines/${this.seg(collection)}/${this.seg(task)}/${this.seg(name)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
  }

  deleteRoutine(collection: string, task: string, name: string): Promise<unknown> {
    return this.http.request(
      `/api/v1/routines/${this.seg(collection)}/${this.seg(task)}/${this.seg(name)}`,
      { method: "DELETE" },
    );
  }

  pauseRoutine(collection: string, task: string, name: string): Promise<unknown> {
    return this.http.request(
      `/api/v1/routines/${this.seg(collection)}/${this.seg(task)}/${this.seg(name)}/pause`,
      { method: "POST" },
    );
  }

  resumeRoutine(collection: string, task: string, name: string): Promise<unknown> {
    return this.http.request(
      `/api/v1/routines/${this.seg(collection)}/${this.seg(task)}/${this.seg(name)}/resume`,
      { method: "POST" },
    );
  }

  runRoutineNow(collection: string, task: string, name: string): Promise<unknown> {
    return this.http.request(
      `/api/v1/routines/${this.seg(collection)}/${this.seg(task)}/${this.seg(name)}/run-now`,
      { method: "POST" },
    );
  }

  listRoutineRuns(
    collection: string,
    task: string,
    name: string,
    limit?: number,
  ): Promise<unknown> {
    const qs = typeof limit === "number" ? `?limit=${limit}` : "";
    return this.http.request(
      `/api/v1/routines/${this.seg(collection)}/${this.seg(task)}/${this.seg(name)}/runs${qs}`,
    );
  }
}
