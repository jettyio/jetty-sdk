/** Resolve before each model call, reusing the arm chosen once at turn.started. */
import { defineDynamic, defineInstructions } from "eve/instructions";

import extension from "../extension";
import { getTurn } from "../lib/state";

export default defineDynamic((ctx) => {
  const { arms, contract } = extension.config;
  const arm = ctx.turn ? getTurn(ctx.turn.id)?.arm : undefined;
  const style = arm && arms[arm] ? `For THIS reply, ${arms[arm]}` : "";
  const content = [style, contract].filter(Boolean).join("\n\n");
  return content ? defineInstructions({ content }) : null;
});
