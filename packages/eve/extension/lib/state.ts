/**
 * Durable, session-scoped arm selection shared by hooks and instructions.
 * defineState is scoped to the extension mount, not the package: two mounts
 * never share their turn captures. Keep the existing key for saved sessions.
 */
import { defineState } from "eve/context";

export interface TurnCapture {
  arm?: string;
}

const turns = defineState("live-eval.turns", (): Record<string, TurnCapture> => ({}));

export function patchTurn(turnId: string, patch: Partial<TurnCapture>): void {
  turns.update((m) => ({ ...m, [turnId]: { ...m[turnId], ...patch } }));
}

export function getTurn(turnId: string): TurnCapture | undefined {
  return turns.get()[turnId];
}

/** Clear on every settlement, including failures/cancellations. */
export function takeTurn(turnId: string): TurnCapture | undefined {
  const t = getTurn(turnId);
  if (t) {
    turns.update((m) => {
      const { [turnId]: _, ...rest } = m;
      return rest;
    });
  }
  return t;
}
