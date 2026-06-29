/**
 * Deterministic stand-in for "run each config over the tickets and grade each."
 * Lets the offline demo print the real verdict shape with no keys and no spend.
 * v1 (warm) clears the bar; v2 (terse) regresses — the whole point.
 */
import { CONFIGS, TICKETS } from "./tickets.js";
import type { RunResult } from "./eval.js";

function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const clamp = (x: number) => Math.max(1, Math.min(5, x));

export function simulateRuns(seed = 7): RunResult[] {
  const rand = lcg(seed);
  const results: RunResult[] = [];
  for (const config of CONFIGS) {
    for (const ticket of TICKETS) {
      // Warm config scores high; terse config scores low (curt replies lose
      // points on tone + completeness with the judge).
      const total =
        config.id === "v1" ? round1(clamp(4.1 + rand() * 0.7)) : round1(clamp(3.0 + rand() * 1.1));
      const costUsd = config.id === "v1" ? 0.0051 : 0.0039; // terse is cheaper
      results.push({
        configId: config.id,
        ticketId: ticket.id,
        total,
        pass: total >= 4.0,
        costUsd,
      });
    }
  }
  return results;
}
