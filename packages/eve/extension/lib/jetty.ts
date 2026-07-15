/**
 * One lazily-constructed JettyClient for all of the extension's contributions,
 * plus the label-write helpers the ingest hook and judge path share.
 *
 * Best-effort by design: with no `collection` configured (or no usable
 * credentials) `jettyClient()` returns undefined, each caller degrades
 * gracefully, and the consuming agent's chat is never affected.
 */
import { JettyClient } from "@jetty/sdk";

import extension from "../extension";

export const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let client: JettyClient | undefined;
let resolved = false;

/** The shared client, or undefined when the extension is unconfigured/disabled. */
export function jettyClient(): JettyClient | undefined {
  if (resolved) return client;
  resolved = true;
  if (!extension.config.collection) {
    console.warn("[@jetty/eve] `collection` unset — live ingest disabled (chat still works).");
    return undefined;
  }
  try {
    client = new JettyClient();
  } catch (err) {
    console.warn(`[@jetty/eve] could not construct JettyClient; live ingest disabled: ${msg(err)}`);
  }
  return client;
}

/**
 * addLabel with retry. A grade a human never sees is a grade that didn't happen —
 * one dropped POST used to leave a judged run permanently unlabeled on the board,
 * so each label gets three attempts with backoff before we give up and log.
 */
export async function addLabelSafe(
  jetty: JettyClient,
  id: string,
  key: string,
  value: string,
): Promise<void> {
  const { collection, task, author } = extension.config;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await jetty.addLabel(collection, task, id, key, value, author);
      return;
    } catch (err) {
      if (attempt === 3) {
        console.warn(`[@jetty/eve] label ${key}=${value} failed after 3 tries: ${msg(err)}`);
        return;
      }
      await sleep(400 * attempt);
    }
  }
}

/**
 * Write the labels, then verify they stuck and re-write any that didn't.
 *
 * Labels POSTed in the first moments after a run reaches `completed` can be lost
 * server-side: mise's own final trajectory write races the label write and clobbers
 * it (observed as runs missing exactly the FIRST label written, with a 200 on every
 * POST — retries can't help because the client never sees a failure). So: settle,
 * write, read back, repair.
 */
export async function writeLabelsVerified(
  jetty: JettyClient,
  id: string,
  labels: Array<[string, string]>,
): Promise<void> {
  const { collection, task } = extension.config;
  await sleep(1500); // let the server's final trajectory write land first
  for (const [k, v] of labels) await addLabelSafe(jetty, id, k, v);
  await sleep(1200);
  try {
    const traj = await jetty.getTrajectory(collection, task, id);
    const present = new Set((traj.labels ?? []).map((l) => l.key));
    const missing = labels.filter(([k]) => !present.has(k));
    for (const [k, v] of missing) {
      console.warn(`[@jetty/eve] label ${k} lost server-side on ${id} — re-writing`);
      await addLabelSafe(jetty, id, k, v);
    }
  } catch (err) {
    console.warn(`[@jetty/eve] label verify on ${id} skipped: ${msg(err)}`);
  }
}
