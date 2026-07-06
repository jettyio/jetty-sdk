/**
 * Rehearsal feeder — drive the live demo without typing by hand.
 *
 *   npx eve dev          # terminal 1
 *   npm run grade-watch  # terminal 2
 *   npm run board        # terminal 3 (open http://localhost:4500)
 *   npm run feed         # terminal 4: sends the sample tickets into eve dev
 *
 * This sends each sample ticket as a raw user message to `eve dev`, exactly as if
 * you'd typed it into the chat — so the agent's bandit picks an arm (warm / terse /
 * balanced) per turn, the ingest hook records each run, and the judge grades it. Use it
 * to test the whole loop end-to-end, or to keep the board moving during a talk. The arm
 * is chosen server-side by the agent (agent/instructions/arm.ts), NOT here.
 */
import { Client } from "eve/client";
import { LIVE_TICKETS, type Ticket } from "./tickets.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const eveUrl = process.env.EVE_URL ?? "http://127.0.0.1:2000";
  const n = Number(process.env.FEED_TICKETS ?? LIVE_TICKETS.length);
  const rounds = Number(process.env.FEED_ROUNDS ?? 1); // >1 to let the bandit converge on stage
  const delayMs = Number(process.env.FEED_DELAY_MS ?? 1200); // pause BETWEEN batches, not per ticket
  const concurrency = Math.max(1, Number(process.env.FEED_CONCURRENCY ?? 4));
  const tickets = LIVE_TICKETS.slice(0, Math.max(1, n));

  const eve = new Client({ host: eveUrl });
  console.log(
    `📨 feeding ${tickets.length} ticket(s) × ${rounds} round(s) into ${eveUrl}, ${concurrency} at a time…`,
  );

  // One clean turn per ticket in a fresh session. Best-effort: a failed turn logs and
  // doesn't sink the rest of the batch.
  const sendOne = async (ticket: Ticket, round: number): Promise<void> => {
    try {
      const session = eve.session();
      const response = await session.send(`${ticket.subject}\n\n${ticket.body}`);
      const turn = await response.result();
      console.log(`  [${round}/${rounds}] ${ticket.id}: turn ${turn.status}`);
    } catch (err) {
      console.warn(`  [${round}/${rounds}] ${ticket.id}: failed — ${err instanceof Error ? err.message : err}`);
    }
  };

  for (let round = 1; round <= rounds; round++) {
    // Fire `concurrency` turns at once, await the batch, then a short beat before the next.
    for (let i = 0; i < tickets.length; i += concurrency) {
      const batch = tickets.slice(i, i + concurrency);
      await Promise.all(batch.map((t) => sendOne(t, round)));
      if (i + concurrency < tickets.length || round < rounds) await sleep(delayMs);
    }
  }
  console.log("done — watch the board light up as grades land.");
}

main().catch((err) => {
  console.error("✗ feed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
