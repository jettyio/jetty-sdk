/** Read the committed v27 snapshot, rather than reconstructing streamed events. */
import { deliveries, reply, runs, type SessionView } from "eve/events";

export function captureTurn(view: SessionView, turnId: string) {
  const input = deliveries(view, { turnId })
    .flatMap((delivery) => delivery.parts ?? [])
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("\n");
  const text = reply(view, turnId)
    .filter((part) => part.kind === "text" && !part.interrupted)
    .map((part) => (typeof part.value === "string" ? part.value : ""))
    .join("\n");
  // Run usage is populated by usage.recorded; includes compaction, excludes tool usage.
  const usage = runs(view, { turnId }).reduce(
    (total, run) => ({
      inTok: total.inTok + (run.usage?.inputTokens ?? 0),
      outTok: total.outTok + (run.usage?.outputTokens ?? 0),
    }),
    { inTok: 0, outTok: 0 },
  );
  return { input, reply: text, ...usage };
}
