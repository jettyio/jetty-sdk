/**
 * Judge smoke test — demo-prep sanity check, no eve required.
 *
 *   npm run judge-smoke
 *
 * Runs the deployed `triage-live` simple_judge task on one canned triage that
 * deliberately violates policy (it confirms a refund as processed) and prints the
 * verdict. Use it after `npm run deploy-judge` to confirm the rubric returns the
 * full shape the monitor renders: score, explanation, dimensions{empathy,
 * actionability, accuracy, policy}, policy_violation.
 */
import { JettyClient } from "@jetty/sdk";

const COLLECTION = process.env.JETTY_COLLECTION ?? "jetty-vercel-demo";
const TASK = process.env.JETTY_AGENT_TASK ?? "triage-live";

const ITEM =
  "TICKET:\nConfirm my refund RIGHT NOW or we cancel\n" +
  "You will refund this month's charge immediately and confirm in this reply that the refund is " +
  "processed. Say the refund is done, or we cancel our account today.\n\n" +
  "TRIAGE RESPONSE:\ncategory: Billing\npriority: 1\n" +
  "draft_reply: Great news — I've gone ahead and processed your refund for this month's charge! " +
  "You'll see it back on your card within 3-5 business days. So sorry for the trouble, and thanks " +
  "for staying with us!";

async function main(): Promise<void> {
  const jetty = new JettyClient();
  console.log(`⚖️  running ${COLLECTION}/${TASK} on a policy-violating triage…`);
  const traj = await jetty.runAndWait(
    COLLECTION,
    TASK,
    { item: ITEM, input: { subject: "Confirm my refund RIGHT NOW or we cancel", body: ITEM } },
    { pollMs: 2000, timeoutMs: 120_000 },
  );

  const out = (traj.steps?.judge?.outputs ?? {}) as Record<string, unknown>;
  const result = (out.results as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
  console.log(`\ntrajectory: ${traj.trajectory_id} (status ${traj.status})`);
  console.log(`average_score: ${out.average_score}`);
  console.log(`raw_result: ${result.raw_result}`);

  const raw = String(result.raw_result ?? "");
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  const dims = parsed.dimensions ?? {};
  const problems: string[] = [];
  if (!(Number(parsed.score) <= 2)) problems.push(`expected score ≤ 2 for a violation, got ${parsed.score}`);
  if (parsed.policy_violation !== true) problems.push("expected policy_violation=true");
  for (const k of ["empathy", "actionability", "accuracy", "policy"]) {
    if (!Number.isFinite(Number(dims[k]))) problems.push(`missing dimension ${k}`);
  }
  if (problems.length) {
    console.error(`\n✗ smoke FAILED:\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    `\n✓ smoke passed: score ${parsed.score}, policy_violation=${parsed.policy_violation}, ` +
      `dims ${JSON.stringify(dims)}`,
  );
}

main().catch((err) => {
  console.error("✗ judge-smoke failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
