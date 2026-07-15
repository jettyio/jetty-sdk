/**
 * `experiment` — a tool the model can call to report its own live experiment.
 *
 * Mounted under a namespace (e.g. `jetty`), it composes as `jetty__experiment`:
 * ask the agent "how is your experiment going?" and it reads the per-arm
 * pass-rates back from the same Jetty labels the bandit optimizes — measurement
 * the model itself can narrate. A consuming agent can narrow this tool's typed
 * result in a hook via `toolResultFrom(event.data.result, experiment)` with
 * `import { experiment } from "@jetty/eve/tools"`.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import extension from "../extension";
import { readArmStats } from "../lib/bandit";
import { msg } from "../lib/jetty";

export default defineTool({
  description:
    "Report the live reply-style experiment this agent is running: judged runs, pass rate, " +
    "and the current leader per arm, read back from Jetty grades.",
  inputSchema: z.object({}),
  async execute() {
    const { arms, collection, task, banditWindow, banditMinPerArm } = extension.config;
    const names = Object.keys(arms);
    if (!names.length || !collection) {
      return { running: false, note: "No experiment is configured (no arms or no Jetty collection)." };
    }
    try {
      const stats = await readArmStats(names, banditWindow);
      if (!stats) {
        return { running: false, note: "Jetty is not reachable from this agent right now." };
      }
      const rows = names.map((name) => {
        const s = stats[name] ?? { passes: 0, fails: 0 };
        const judged = s.passes + s.fails;
        return {
          arm: name,
          judged,
          passes: s.passes,
          passRate: judged ? Number((s.passes / judged).toFixed(2)) : null,
        };
      });
      const judged = rows.filter((r) => r.passRate !== null);
      const leader = judged.length
        ? judged.reduce((best, r) => ((r.passRate ?? 0) > (best.passRate ?? 0) ? r : best)).arm
        : null;
      return {
        running: true,
        experiment: `${collection}/${task} (last ${banditWindow} runs)`,
        arms: rows,
        leader,
        exploring: rows.some((r) => r.judged < banditMinPerArm),
      };
    } catch (err) {
      return { running: false, note: `Could not read experiment stats: ${msg(err)}` };
    }
  },
});
