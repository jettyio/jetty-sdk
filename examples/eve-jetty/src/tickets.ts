/** The eval dataset + the two agent configs we're comparing. */

export interface Ticket {
  id: string;
  subject: string;
  body: string;
  tier: string;
}

/** A small, varied support-ticket set — the eval cases. */
export const TICKETS: Ticket[] = [
  {
    id: "reset",
    subject: "Password reset email never arrives",
    body: "Tried the reset link 3x over an hour — no email, checked spam.",
    tier: "pro",
  },
  {
    id: "double-charge",
    subject: "Charged twice this month",
    body: "I see two identical charges on the 3rd. Can you refund the duplicate?",
    tier: "enterprise",
  },
  {
    id: "export",
    subject: "How do I export my data as CSV?",
    body: "I need to pull our Q2 numbers into a spreadsheet. Is there an export?",
    tier: "free",
  },
  {
    id: "down",
    subject: "Dashboard is completely down",
    body: "Getting a 500 on every page since ~9am. This is blocking our team.",
    tier: "enterprise",
  },
  {
    id: "cancel",
    subject: "Thinking about cancelling",
    body: "It's gotten slow and we're not sure it's worth it anymore. Convince me?",
    tier: "pro",
  },
];

export interface AgentConfig {
  id: string;
  label: string;
  /** Style guidance appended to the shared JSON-output contract. */
  style: string;
}

const JSON_CONTRACT =
  "You are Acme's support-ticket triage agent. Given a ticket as JSON, respond with ONLY a JSON " +
  'object (no prose, no code fences): { "category": string, "priority": number (1=highest..5=lowest), ' +
  '"draft_reply": string }.';

/** The two configs under test. v2 is deliberately worse — the regression. */
export const CONFIGS: AgentConfig[] = [
  {
    id: "v1",
    label: "v1 (warm)",
    style:
      "draft_reply should be a warm, specific first response: acknowledge the problem, give a concrete next step, and match the customer's tier.",
  },
  {
    id: "v2",
    label: "v2 (terse)",
    style:
      "draft_reply MUST be a single terse sentence. Do not apologize, do not add steps or detail, do not personalize.",
  },
];

export function instructionsFor(config: AgentConfig): string {
  return `${JSON_CONTRACT}\n${config.style}`;
}
