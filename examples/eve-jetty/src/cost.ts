/**
 * Estimate per-run cost from an eve turn's token usage.
 *
 * Flue handed us a dollar cost directly (`response.usage.cost.total`). eve does NOT:
 * it reports token usage on `step.completed` events but exposes no cost field. So we
 * derive an estimate from the turn's tokens and a small per-model price table — enough
 * to keep the verdict table's "cheaper but worse" signal honest. The harness labels it
 * `eval.cost_est_usd` (note the `_est_`). Tune PRICES to your provider / AI Gateway rates.
 *
 * eve's `step.completed.data.usage` is `{ inputTokens?, outputTokens?, cacheReadTokens?,
 * cacheWriteTokens? }`. We price input + output and ignore cache tokens for simplicity.
 */
import type { HandleMessageStreamEvent } from "eve/client";

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inUsdPerM: number;
  /** USD per 1M output tokens. */
  outUsdPerM: number;
}

// Illustrative list prices ($ / 1M tokens). Tune these to your real rates.
const PRICES: Record<string, ModelPrice> = {
  "anthropic/claude-sonnet-4.6": { inUsdPerM: 3, outUsdPerM: 15 },
  "anthropic/claude-opus-4.8": { inUsdPerM: 15, outUsdPerM: 75 },
  "openai/gpt-5.4-mini": { inUsdPerM: 0.4, outUsdPerM: 1.6 },
};
const DEFAULT_PRICE: ModelPrice = { inUsdPerM: 3, outUsdPerM: 15 };

/** Sum input/output tokens across a turn's `step.completed` events and price them. */
export function estimateCostFromEvents(
  events: readonly HandleMessageStreamEvent[] | undefined,
  model: string,
): number {
  const price = PRICES[model] ?? DEFAULT_PRICE;
  let input = 0;
  let output = 0;
  for (const ev of events ?? []) {
    if (ev.type !== "step.completed") continue;
    input += ev.data.usage?.inputTokens ?? 0;
    output += ev.data.usage?.outputTokens ?? 0;
  }
  return (input / 1e6) * price.inUsdPerM + (output / 1e6) * price.outUsdPerM;
}
