import { JettyError } from "./errors.js";
import { TERMINAL_STATUSES, type TrajectoryStatus } from "./types.js";

export interface ParsedWorkflowId {
  collection: string;
  task: string;
  /** The 8-hex trajectory id — the part the polling endpoint actually wants. */
  trajectoryId: string;
}

/**
 * Split a run's `workflow_id` into its parts.
 *
 * The server builds it as `f"{collection}/{task}--{trajectory_id}"` with `/`
 * replaced by `-` (see `mise/mise/flows/bakery_utils.py`). So the only
 * unambiguous field is the `trajectoryId` after the last `--`; the
 * collection/task split on the left is best-effort (collection names may
 * contain dashes). Polling only needs `trajectoryId`, and callers already know
 * their collection/task — so prefer those over the parsed left side.
 *
 * @throws {JettyError} if the id has no `--` separator.
 */
export function parseWorkflowId(workflowId: string): ParsedWorkflowId {
  const sep = workflowId.lastIndexOf("--");
  if (sep === -1) {
    throw new JettyError(
      `Malformed workflow_id (expected "<collection>-<task>--<trajectoryId>"): ${workflowId}`,
    );
  }
  const left = workflowId.slice(0, sep);
  const trajectoryId = workflowId.slice(sep + 2);
  const firstDash = left.indexOf("-");
  const collection = firstDash === -1 ? left : left.slice(0, firstDash);
  const task = firstDash === -1 ? "" : left.slice(firstDash + 1);
  return { collection, task, trajectoryId };
}

/** True once a trajectory has reached a terminal status. */
export function isTerminalStatus(status: string): status is TrajectoryStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}
