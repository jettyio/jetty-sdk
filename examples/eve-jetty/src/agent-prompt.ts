/**
 * Per-run prompt + output parsing for the eve triage agent.
 *
 * The shared JSON-output contract lives in `agent/instructions.md` (eve's always-on
 * system prompt). Here we build only the per-config message — the style under test
 * plus the ticket — and parse the model's JSON back out. So one eve agent serves the
 * whole A/B comparison, with the warm/terse style injected per run (the same trick as
 * the flue-jetty example).
 */
import type { AgentConfig, Ticket } from "./tickets.js";

export interface Triage {
  category: string;
  priority: number;
  draft_reply: string;
}

/** The per-config user message: the style under test, then the ticket to triage. */
export function triagePrompt(config: AgentConfig, ticket: Ticket): string {
  return `${config.style}\n\nTriage this support ticket now. Respond with ONLY the JSON object.\nTicket:\n${JSON.stringify(ticket)}`;
}

/** Pull the first {...} JSON object out of model text (tolerates fences/prose). */
export function extractTriage(text: string): Triage {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) {
    throw new Error(`Agent did not return JSON. Got: ${text.slice(0, 160)}`);
  }
  return JSON.parse(text.slice(start, end + 1)) as Triage;
}
