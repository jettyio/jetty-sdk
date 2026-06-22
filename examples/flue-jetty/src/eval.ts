/**
 * The eval itself: aggregate per-run grades into a per-config verdict, and
 * render the one table a builder needs to see.
 *
 * Each run is one (config, ticket) pair: the agent drafted a triage, the Jetty
 * grader scored it (1–5), and we recorded the score + the run's cost. Aggregate
 * tells you, per config: pass-rate, average score, average $/run — and which
 * config regressed below the bar.
 */
import type { AgentConfig } from "./tickets.js";

/** A run passes when the grader's total is at/above this. */
export const PASS_BAR = 4.0;

export interface RunResult {
  configId: string;
  ticketId: string;
  total: number; // grader score, 1–5
  pass: boolean;
  costUsd: number; // cost of the agent draft for this run
  trajectoryId?: string;
}

export interface ConfigSummary {
  configId: string;
  label: string;
  runs: number;
  passes: number;
  passRate: number;
  avgScore: number;
  avgCostUsd: number;
}

export interface Verdict {
  bar: number;
  ticketCount: number;
  summaries: ConfigSummary[];
  winnerId: string;
  regressedIds: string[];
}

function summarize(results: RunResult[], config: AgentConfig): ConfigSummary {
  const rs = results.filter((r) => r.configId === config.id);
  const runs = rs.length;
  const passes = rs.filter((r) => r.pass).length;
  return {
    configId: config.id,
    label: config.label,
    runs,
    passes,
    passRate: runs ? passes / runs : 0,
    avgScore: runs ? rs.reduce((a, r) => a + r.total, 0) / runs : 0,
    avgCostUsd: runs ? rs.reduce((a, r) => a + r.costUsd, 0) / runs : 0,
  };
}

export function aggregate(results: RunResult[], configs: AgentConfig[], bar = PASS_BAR): Verdict {
  const summaries = configs.map((c) => summarize(results, c));
  const ranked = [...summaries].sort(
    (a, b) => b.passRate - a.passRate || b.avgScore - a.avgScore,
  );
  const winner = ranked[0];
  const regressedIds = summaries
    .filter((s) => s.configId !== winner.configId && s.passRate < winner.passRate)
    .map((s) => s.configId);
  const ticketCount = Math.max(0, ...summaries.map((s) => s.runs));
  return { bar, ticketCount, summaries, winnerId: winner.configId, regressedIds };
}

/** Render the verdict as the table a builder reads in one glance. */
export function renderVerdict(verdict: Verdict, graderLabel = "rubric (independent)"): string {
  const lines: string[] = [];
  lines.push(`TICKETS: ${verdict.ticketCount}   GRADER: ${graderLabel}`);
  lines.push("");
  lines.push(" config        pass   avg   $/run");
  lines.push(" ------------  -----  ----  -------");
  for (const s of verdict.summaries) {
    const mark =
      s.configId === verdict.winnerId
        ? "✅"
        : verdict.regressedIds.includes(s.configId)
          ? "❌  regressed"
          : "";
    const pass = `${s.passes}/${s.runs}`;
    lines.push(
      ` ${s.label.padEnd(12)} ${pass.padEnd(5)}  ${s.avgScore.toFixed(1)}   ${s.avgCostUsd.toFixed(4)}  ${mark}`,
    );
  }
  lines.push("");

  const winner = verdict.summaries.find((s) => s.configId === verdict.winnerId)!;
  if (verdict.regressedIds.length) {
    const reg = verdict.summaries.find((s) => s.configId === verdict.regressedIds[0])!;
    const cheaper = reg.avgCostUsd < winner.avgCostUsd;
    lines.push(
      `→ ${reg.label} ${cheaper ? "is cheaper but " : ""}fails the bar (${verdict.bar.toFixed(1)}). Keep ${winner.label}.`,
    );
  } else {
    lines.push(`→ ${winner.label} clears the bar (${verdict.bar.toFixed(1)}).`);
  }
  return lines.join("\n");
}
