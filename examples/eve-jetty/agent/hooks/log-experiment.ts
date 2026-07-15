/**
 * Typed tool results across the extension boundary.
 *
 * When the model calls the mounted `jetty__experiment` tool ("how is the
 * experiment going?"), this consumer-side hook narrows the result via
 * `toolResultFrom` — identity keys off the tool DEFINITION imported from
 * `@jetty/eve/tools`, so it matches the namespaced runtime name and the output
 * is fully typed. One console line per call, so a stage demo can show the
 * model reading its own scoreboard.
 */
import { defineHook } from "eve/hooks";
import { toolResultFrom } from "eve/tools";
import { experiment } from "@jetty/eve/tools";

export default defineHook({
  events: {
    "action.result"(event) {
      const match = toolResultFrom(event.data.result, experiment);
      if (!match) return;
      const out = match.output;
      if (out.running && out.arms) {
        const rows = out.arms
          .map((a) => `${a.arm} ${a.passes}/${a.judged}${a.passRate != null ? ` (${a.passRate})` : ""}`)
          .join("  ");
        console.log(`[experiment] model checked the scoreboard: ${rows} — leader: ${out.leader ?? "none yet"}`);
      } else {
        console.log(`[experiment] model checked the scoreboard: ${out.note ?? "not running"}`);
      }
    },
  },
});
