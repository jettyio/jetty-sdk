/**
 * Rehearsal feeder — drive the live demo without typing by hand.
 *
 *   npx eve dev          # terminal 1
 *   npm run grade-watch  # terminal 2
 *   npm run board        # terminal 3 (open http://localhost:4500)
 *   npm run feed         # terminal 4: sends the sample tickets into eve dev
 *
 * This sends each sample ticket as a raw user message to `eve dev`, exactly as if
 * you'd typed it into the chat — so the agent randomizes warm/terse per turn, the
 * ingest hook records each run, and the watcher grades it. Use it to test the whole
 * loop end-to-end, or to keep the board moving during a talk. The arm is chosen
 * server-side by the agent (agent/instructions/arm.ts), NOT here.
 */
import { Client } from "eve/client";
import { TICKETS } from "./tickets.js";

async function main(): Promise<void> {
  const eveUrl = process.env.EVE_URL ?? "http://127.0.0.1:2000";
  const n = Number(process.env.FEED_TICKETS ?? TICKETS.length);
  const delayMs = Number(process.env.FEED_DELAY_MS ?? 2500);
  const tickets = TICKETS.slice(0, Math.max(1, n));

  const eve = new Client({ host: eveUrl });
  console.log(`📨 feeding ${tickets.length} ticket(s) into ${eveUrl} (${delayMs}ms apart)…`);

  for (const ticket of tickets) {
    // A fresh session per ticket = one clean turn each.
    const session = eve.session();
    const response = await session.send(`${ticket.subject}\n\n${ticket.body}`);
    const turn = await response.result();
    console.log(`  sent ${ticket.id}: turn ${turn.status}`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  console.log("done — watch the board light up as grades land.");
}

main().catch((err) => {
  console.error("✗ feed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
