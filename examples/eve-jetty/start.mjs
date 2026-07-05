#!/usr/bin/env node
/**
 * One-command launcher for the eve × Jetty live demo.
 *
 *   npm start                 # deploy the judge (once), then run the agent + monitor together
 *   npm start -- --feed       # ...and auto-send the sample tickets (hands-free demo)
 *   npm start -- --check      # validate .env and print the plan, WITHOUT launching anything
 *   npm start -- --no-judge   # skip the one-time judge deploy (it's already deployed)
 *   npm start -- --help
 *
 * Every process reads examples/eve-jetty/.env, so the agent, the bandit, the judge, and the
 * monitor all point at one collection + one task and arm the gate at one threshold. Ctrl-C
 * stops every child cleanly. Zero dependencies (Node 18+ built-ins).
 */
import { spawn } from "node:child_process";
import { readFileSync, copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url)); // examples/eve-jetty

// --- colors (off when not a TTY) ---
const TTY = process.stdout.isTTY;
const paint = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => paint("1", s);
const dim = (s) => paint("2", s);
const red = (s) => paint("31", s);
const green = (s) => paint("32", s);
const yellow = (s) => paint("33", s);
const mag = (s) => paint("35", s);
const cyan = (s) => paint("36", s);

// --- tiny .env loader (matches monitor/server.mjs: bare KEY=value, real env wins) ---
function loadDotenv(p) {
  let text;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return false;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || line.trimStart().startsWith("#")) continue;
    if (process.env[m[1]] !== undefined) continue; // never override a real env var
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return true;
}

// --- flags ---
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
if (has("--help") || has("-h")) {
  printHelp();
  process.exit(0);
}
const CHECK = has("--check") || has("--dry-run");
const NO_JUDGE = has("--no-judge");
const DO_FEED = has("--feed");

// --- .env: create from the example on first run, then bail so they can fill it in ---
const envPath = join(ROOT, ".env");
if (!existsSync(envPath)) {
  if (existsSync(join(ROOT, ".env.example"))) {
    copyFileSync(join(ROOT, ".env.example"), envPath);
    console.log(
      yellow("Created .env from .env.example.") +
        " Open it, paste your JETTY_API_TOKEN and a model key (OPENROUTER_API_KEY),\nthen run " +
        bold("npm start") +
        " again.",
    );
  } else {
    console.error(red("✗ No .env and no .env.example in " + ROOT));
  }
  process.exit(1);
}
loadDotenv(envPath);

// --- resolve the shared config ---
const COLLECTION = process.env.JETTY_COLLECTION || "jetty-vercel-demo";
const TASK = process.env.JETTY_AGENT_TASK || "triage-live";
const EVE_URL = process.env.EVE_URL || "http://127.0.0.1:2000";
const MONITOR_PORT = Number(process.env.MONITOR_PORT || process.env.PORT || 4600);
// `npm start` deploys the judge below, so run the agent in simple_judge mode by default —
// otherwise a fresh `cp .env.example .env` (JUDGE_MODE unset) makes the hook ingest each turn
// UNGRADED and the board never shows a grade. An explicit JUDGE_MODE in .env/env still wins.
process.env.JUDGE_MODE ??= "simple_judge";
const JUDGE_MODE = process.env.JUDGE_MODE;
const token = process.env.JETTY_API_TOKEN || "";
const tokenBad = !token || /x{6,}/i.test(token); // missing or the mlc_xxxx… placeholder
const modelCred =
  process.env.OPENROUTER_API_KEY || process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;

// --- banner ---
console.log(bold("\n  eve × Jetty — live demo\n"));
console.log(`  collection   ${cyan(COLLECTION)}`);
console.log(
  `  task         ${cyan(TASK)}   ${dim("(agent ingests · judge grades · monitor watches — one name)")}`,
);
console.log(`  agent        ${cyan(EVE_URL)}`);
console.log(`  dashboard    ${cyan("http://localhost:" + MONITOR_PORT)}`);
console.log(`  judge mode   ${cyan(JUDGE_MODE)}\n`);

// --- validate ---
if (tokenBad) {
  console.error(
    red("✗ JETTY_API_TOKEN is missing or still the placeholder.") +
      "\n  Paste your token into " +
      bold(".env") +
      " — get one at https://jetty.io → Settings → API Tokens.\n",
  );
  process.exit(1);
}
if (!modelCred) {
  console.warn(
    yellow("⚠ No model credential for the local agent") +
      " (OPENROUTER_API_KEY / AI_GATEWAY_API_KEY / VERCEL_OIDC_TOKEN).",
  );
  console.warn(
    dim(
      "  eve runs the agent on YOUR machine, so it needs one to draft replies.\n" +
        "  Jetty's trial keys only cover the server-side judge, not the local agent.\n",
    ),
  );
}
if (JUDGE_MODE === "ingest") {
  console.warn(
    yellow("⚠ JUDGE_MODE=ingest") +
      dim(
        " — turns are ingested UNGRADED; this launcher doesn't run the grader,\n" +
          "  so the board won't show grades. Run `npm run grade-watch` too, or use JUDGE_MODE=simple_judge.\n",
      ),
  );
}

if (CHECK) {
  console.log(green("✓ config looks good.") + dim("  Plan (nothing launched — this is --check):"));
  console.log(`    1. ${NO_JUDGE ? dim("skip judge deploy") : "deploy judge task  " + dim(COLLECTION + "/" + TASK)}`);
  console.log(`    2. start agent       ${dim("npx eve dev → " + EVE_URL)}`);
  console.log(`    3. start monitor     ${dim("node monitor/server.mjs → :" + MONITOR_PORT)}`);
  console.log(
    `    4. ${DO_FEED ? "feed sample tickets  " + dim("npm run feed") : dim("wait for you to type into eve dev (pass --feed to auto-send)")}\n`,
  );
  process.exit(0);
}

// --- process management: each service runs in its own group so Ctrl-C kills the tree ---
const children = [];
let shuttingDown = false;

function pipeLines(stream, tag, isErr) {
  let buf = "";
  stream.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      (isErr ? process.stderr : process.stdout).write(`${tag} ${line}\n`);
    }
  });
}

function launch(name, color, cmd, cmdArgs) {
  const child = spawn(cmd, cmdArgs, {
    cwd: ROOT,
    env: process.env,
    detached: true, // new process group → process.kill(-pid) stops the whole tree
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const tag = color(`[${name}]`);
  pipeLines(child.stdout, tag, false);
  pipeLines(child.stderr, tag, true);
  child.on("exit", (code) => {
    if (shuttingDown) return;
    if (code && code !== 0) {
      console.error(red(`\n✗ [${name}] exited (code ${code}). Stopping the rest.`));
      cleanup(1);
    }
  });
  return child;
}

function cleanup(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(dim("\nstopping…\n"));
  for (const ch of children) {
    if (ch.pid && ch.exitCode === null) {
      try {
        process.kill(-ch.pid, "SIGTERM");
      } catch {
        try {
          ch.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }
  }
  setTimeout(() => process.exit(exitCode), 800);
}
process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));

/** Run an npm script to completion; resolves with its exit code. */
function runToEnd(name, color, script) {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", script], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tag = color(`[${name}]`);
    pipeLines(child.stdout, tag, false);
    pipeLines(child.stderr, tag, true);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(url, { ms, want200 }) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (!want200 || res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(700);
  }
  return false;
}

(async () => {
  // 1. deploy the judge (idempotent create-or-update) unless told to skip.
  if (!NO_JUDGE) {
    console.log(cyan("→ deploying judge task ") + dim(`${COLLECTION}/${TASK} …`));
    const code = await runToEnd("judge", cyan, "deploy-judge");
    if (code !== 0) {
      console.error(
        red("\n✗ deploy-judge failed.") +
          " Check your token/collection, or pass " +
          bold("--no-judge") +
          " if it's already deployed. Then re-run.",
      );
      process.exit(1);
    }
    console.log(green("✓ judge deployed.\n"));
  } else {
    console.log(dim("→ skipping judge deploy (--no-judge)\n"));
  }

  // 2 + 3. agent and monitor, side by side.
  console.log(mag("→ starting agent  ") + dim("npx eve dev …"));
  launch("agent", mag, "npx", ["eve", "dev"]);
  console.log(green("→ starting monitor ") + dim("node monitor/server.mjs …\n"));
  launch("monitor", green, "node", ["monitor/server.mjs"]);

  const monitorUp = await waitFor(`http://localhost:${MONITOR_PORT}/`, { ms: 15000, want200: true });
  const agentUp = await waitFor(EVE_URL, { ms: 45000, want200: false });

  console.log(bold("\n  ──────────────────────────────────────────────"));
  console.log(bold("   eve × Jetty demo is live"));
  console.log(`   ${green("● dashboard")}  http://localhost:${MONITOR_PORT}   ${monitorUp ? green("up") : yellow("still starting…")}`);
  console.log(`   ${mag("● agent")}      ${EVE_URL}   ${agentUp ? green("up") : yellow("still starting…")}`);
  console.log(bold("  ──────────────────────────────────────────────\n"));
  console.log(
    DO_FEED
      ? dim("   Feeding sample tickets — watch the dashboard fill in.")
      : dim("   Type a support ticket into eve dev — or re-run with --feed to auto-send samples."),
  );
  console.log(dim("   Ctrl-C stops everything.\n"));

  // 4. optional: drive it hands-free.
  if (DO_FEED) {
    if (!agentUp) console.warn(yellow("   (agent not confirmed up yet — feeding anyway)"));
    launch("feed", yellow, "npm", ["run", "feed"]);
  }
})();

function printHelp() {
  const b = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
  console.log(`
${b("eve × Jetty — one-command live demo launcher")}

  npm start                 deploy the judge (once), then run the agent + monitor together
  npm start -- --feed       ...and auto-send the sample tickets (hands-free)
  npm start -- --check      validate .env and print the plan, without launching
  npm start -- --no-judge   skip the one-time judge deploy (already deployed)
  npm start -- --help       this help

Everything reads examples/eve-jetty/.env. Needs JETTY_API_TOKEN and a model key for the
local agent (OPENROUTER_API_KEY, or an AI Gateway credential). Dashboard: http://localhost:4600.
`);
}
