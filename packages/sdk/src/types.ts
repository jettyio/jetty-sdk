/**
 * TypeScript mirrors of the Jetty backend Pydantic models.
 *
 * Sources (mise):
 *   - Trajectory / Step / Label / TrajectoryAttribute — `mise/mise/types.py`
 *   - RunRequestBody / WorkflowResponse — `mise/mise/api/endpoints/flows.py`
 *
 * Index signatures are deliberately present on the outer resource shapes so the
 * SDK stays forward-compatible as the server adds fields.
 */

/** Lifecycle status of a trajectory. `completed` is the only success state. */
export type TrajectoryStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "archived";

/** Terminal statuses — polling stops once a trajectory reaches one of these. */
export const TERMINAL_STATUSES: readonly TrajectoryStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "archived",
];

export interface Label {
  key: string;
  value: string;
  created: string;
  author: string;
}

export interface Step {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  activity: string;
  key: string;
  depends_on: string[];
  created: string;
  ended: string;
  duration_seconds: number | null;
  author: string;
  origin: Record<string, unknown>;
  config: Record<string, unknown>;
}

export interface TrajectoryAttribute {
  asset_type: string;
  asset_filename: string;
  created: string;
  params: Record<string, unknown>;
}

/** init_params, with the well-known `file_paths` populated by file uploads. */
export type InitParams = Record<string, unknown> & { file_paths?: string[] };

export interface Trajectory {
  name: string;
  trajectory_id: string;
  storage_path: string;
  status: TrajectoryStatus;
  attributes: TrajectoryAttribute;
  created: string;
  updated: string;
  author: string;
  metadata_uri: string;
  steps: Record<string, Step>;
  labels: Label[];
  total_steps: string[];
  completed_steps: string[];
  init_params: InitParams;
  step_configs: Record<string, unknown>;
  org_id: string | null;
  error: string | null;
  triggered_by_routine_id?: number | null;
  webhook_url?: string | null;
  [key: string]: unknown;
}

/** Response from the run endpoints (`POST /api/v1/run/...`). */
export interface WorkflowResponse {
  message: string;
  /** Shaped `"<collection>-<task>--<trajectoryId>"`. See `parseWorkflowId`. */
  workflow_id: string;
  result: Record<string, unknown>;
  trajectory: Record<string, unknown>;
  metadata: string;
  [key: string]: unknown;
}

/** Options accepted by the run endpoints beyond `init_params`. */
export interface RunOptions {
  /** Use the collection's trial keys instead of its configured provider keys. */
  useTrialKeys?: boolean;
  /** Secret params merged server-side and scrubbed from the trajectory. */
  secretParams?: Record<string, unknown>;
  /** Run the agent on a linked subscription's quota (JET-351). */
  subscriptionCredential?: "nous" | "codex" | "anthropic";
  /** Notify this URL when the run completes. */
  webhookUrl?: string;
  /** HMAC secret for the webhook signature. */
  webhookSecret?: string;
}

/** Accepted file payloads for uploads (avoids the DOM-only `BlobPart`). */
export type JettyFileData = Blob | ArrayBuffer | ArrayBufferView | string;

/** A file to upload with a run (multipart). */
export interface JettyFile {
  filename: string;
  /** File bytes/content: a Blob, ArrayBuffer, typed array (e.g. Buffer), or string. */
  data: JettyFileData;
  contentType?: string;
}

export interface Collection {
  name: string;
  [key: string]: unknown;
}

export interface Task {
  name: string;
  description?: string;
  workflow?: unknown;
  [key: string]: unknown;
}

export interface StepTemplate {
  name: string;
  [key: string]: unknown;
}

/** Wrapped list response from `GET /api/v1/db/trajectories/...`. */
export interface TrajectoryListResponse {
  trajectories: Trajectory[];
  total?: number;
  page?: number;
  limit?: number;
  [key: string]: unknown;
}

/** Options for {@link JettyClient.runAndWait}. */
export interface RunAndWaitOptions extends RunOptions {
  /** Poll interval in ms. Default 2000. */
  pollMs?: number;
  /** Overall wait budget in ms before throwing JettyTimeoutError. Default 1_800_000. */
  timeoutMs?: number;
  /** Called with the latest trajectory on each poll — handy for progress UIs. */
  onPoll?: (trajectory: Trajectory) => void;
  /** Files to upload with the run (multipart → init_params.file_paths[]). */
  files?: JettyFile[];
}
