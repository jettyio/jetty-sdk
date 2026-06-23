/**
 * The Acme triage agent — built with Flue. Flue owns the loop; Jetty grades the
 * output. The A/B configs (warm vs terse) aren't separate agents: there's one
 * agent, and each config's style is injected into the prompt per run, so a
 * single bound agent serves the whole comparison.
 */
import { defineAgent } from "@flue/runtime";
import { type AgentConfig, type Ticket, instructionsFor } from "./tickets.js";

export interface Triage {
  category: string;
  priority: number;
  draft_reply: string;
}

/** One triage agent. The per-config style lives in the prompt (see `triagePrompt`). */
export const triageAgent = defineAgent(() => ({
  model: process.env.FLUE_MODEL ?? "anthropic/claude-sonnet-4-6",
}));

/** Build the triage prompt for a config × ticket: shared JSON contract + style + the ticket. */
export function triagePrompt(config: AgentConfig, ticket: Ticket): string {
  return `${instructionsFor(config)}\n\nTriage this support ticket now. Respond with ONLY the JSON object.\nTicket:\n${JSON.stringify(ticket)}`;
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
