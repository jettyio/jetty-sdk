/**
 * The Acme triage agent — an eve agent is a directory. This file is the runtime
 * config; the always-on system prompt lives in `instructions.md` and the per-run
 * warm/terse style is injected by the A/B harness (src/agent-prompt.ts).
 *
 * By default the model is a bare string resolved through Vercel AI Gateway: a
 * deployed agent uses Vercel OIDC, a local one needs AI_GATEWAY_API_KEY (or
 * `eve link`). No AI Gateway credential? Set OPENROUTER_API_KEY and the agent
 * talks to OpenRouter directly — an AI SDK "external" provider that bypasses the
 * gateway (eve's `model` field accepts any AI SDK LanguageModel, not just a string).
 */
import { defineAgent } from "eve";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const MODEL = process.env.EVE_MODEL ?? "anthropic/claude-sonnet-5";
const useOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);

const model = useOpenRouter
  ? createOpenAICompatible({
      name: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
    })(MODEL)
  : MODEL;

export default defineAgent({
  model,
  // An external (non-gateway) provider has no AI Gateway catalog metadata, so eve
  // needs the model's context window for compaction. Claude Sonnet 5 is 1M tokens.
  modelContextWindowTokens: useOpenRouter ? 1_000_000 : undefined,
});
