/**
 * The Acme triage agent — built with Flue, parameterized by config so we can
 * A/B two versions of it. Flue owns the loop; Jetty grades the output.
 */
import { createAgent } from "@flue/runtime";
import { type AgentConfig, instructionsFor } from "./tickets.js";

export interface Triage {
  category: string;
  priority: number;
  draft_reply: string;
}

export function makeTriageAgent(config: AgentConfig) {
  return createAgent(() => ({
    model: process.env.FLUE_MODEL ?? "anthropic/claude-sonnet-4-6",
    description: `Acme Helpdesk triage agent (${config.label}).`,
    instructions: instructionsFor(config),
  }));
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
