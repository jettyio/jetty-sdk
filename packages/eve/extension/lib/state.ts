/**
 * Durable per-session state shared by the extension's contributions.
 *
 * The dynamic-instructions resolver (instructions/arm.ts) records which arm a
 * turn plays; the ingest hook (hooks/ingest.ts) accumulates the turn's
 * input/reply/token usage across stream events and drains the slot on
 * `turn.completed`. eve bundles each contribution separately, so a plain module
 * variable would give each bundle its own copy — `defineState` keys the slot by
 * NAME (auto-scoped to this extension's package), so every contribution reads
 * and writes the same durable value. State is session-scoped, which is also why
 * plain `turnId` keys are safe here: eve turn ids (`turn_0`, `turn_1`, …) only
 * repeat across sessions, never within one.
 */
import { defineState } from "eve/context";

export interface TurnCapture {
  /** The experiment arm this turn played (written by instructions/arm.ts). */
  arm?: string;
  /** The user's message (from `message.received`). */
  input?: string;
  /** The assistant's finished reply (from `message.completed`). */
  reply?: string;
  /** Token usage summed over the turn's `step.completed` events. */
  inTok: number;
  outTok: number;
}

const turns = defineState("live-eval.turns", (): Record<string, TurnCapture> => ({}));

/** Merge a partial capture into the turn's slot. */
export function patchTurn(turnId: string, patch: Partial<TurnCapture>): void {
  turns.update((m) => {
    const t = m[turnId] ?? { inTok: 0, outTok: 0 };
    return { ...m, [turnId]: { ...t, ...patch } };
  });
}

/** Add a step's token usage to the turn's running totals. */
export function addTurnUsage(turnId: string, inTok: number, outTok: number): void {
  turns.update((m) => {
    const t = m[turnId] ?? { inTok: 0, outTok: 0 };
    return { ...m, [turnId]: { ...t, inTok: t.inTok + inTok, outTok: t.outTok + outTok } };
  });
}

/** Read and clear the turn's capture (called once, on `turn.completed`). */
export function takeTurn(turnId: string): TurnCapture | undefined {
  const t = turns.get()[turnId];
  if (t) {
    turns.update((m) => {
      const { [turnId]: _, ...rest } = m;
      return rest;
    });
  }
  return t;
}
