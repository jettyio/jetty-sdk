/** Choose once per turn, before any dynamic instruction/model resolution. */
import { defineHook } from "eve/hooks";

import extension from "../extension";
import { pickArm } from "../lib/bandit";
import { patchTurn } from "../lib/state";

export default defineHook({
  events: {
    "turn.started"(event) {
      const names = Object.keys(extension.config.arms);
      if (names.length) patchTurn(event.data.turnId, { arm: pickArm(names) });
    },
  },
});
