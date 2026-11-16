import { readFile } from "node:fs/promises";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { emptySessionView, foldEvents, type Fact, type ReceivedEvent } from "eve/events";
import { captureTurn } from "../extension/lib/capture";
import { Jetty } from "../reporter/index";

const mocks = vi.hoisted(() => ({
  config: {
    collection: "test",
    task: "live",
    author: "test",
    judgeMode: "ingest",
    passBar: 3,
    priceInPerMTok: 3,
    priceOutPerMTok: 15,
    arms: { warm: "be warm", terse: "be terse" },
    contract: "JSON only",
  },
  selected: {} as Record<string, { arm: string }>,
  ingest: vi.fn(),
  runAndWait: vi.fn(),
  labels: vi.fn(),
  pick: vi.fn(() => "warm"),
  enabled: true,
}));
vi.mock("../extension/extension", () => ({ default: { config: mocks.config } }));
vi.mock("../extension/lib/state", () => ({
  patchTurn: (id: string, patch: { arm: string }) => {
    mocks.selected[id] = patch;
  },
  getTurn: (id: string) => mocks.selected[id],
  takeTurn: (id: string) => {
    const t = mocks.selected[id];
    delete mocks.selected[id];
    return t;
  },
}));
vi.mock("../extension/lib/bandit", () => ({ pickArm: mocks.pick }));
vi.mock("../extension/lib/jetty", () => ({
  jettyClient: () =>
    mocks.enabled ? { ingestTrajectory: mocks.ingest, runAndWait: mocks.runAndWait } : undefined,
  writeLabelsVerified: mocks.labels,
  msg: (e: unknown) => String(e),
}));
// Exercise the resolver directly; compilation/build checks the real eve sentinel.
vi.mock("eve/instructions", () => ({
  defineDynamic: (fn: unknown) => fn,
  defineInstructions: (value: unknown) => value,
}));
import ingestHook from "../extension/hooks/ingest";
import armHook from "../extension/hooks/arm";
import instructions from "../extension/instructions/arm";

function snapshot() {
  const facts: Fact[] = [
    { type: "session.started", data: {} },
    { type: "turn.started", data: { turnId: "t", cause: { deliveryId: "d" }, follows: null } },
    { type: "delivery.admitted", data: { deliveryId: "d" } },
    {
      type: "delivery.consumed",
      data: {
        deliveryId: "d",
        turnId: "t",
        parts: [
          { kind: "text", text: "Help me" },
          { kind: "file", mediaType: "image/png" },
        ],
      },
    },
    { type: "model.requested", data: { runId: "r", owner: { turnId: "t" } } },
    {
      type: "content.completed",
      data: {
        partId: "reason",
        runId: "r",
        kind: "reasoning",
        phase: "reply",
        value: "secret reasoning",
      },
    },
    {
      type: "content.completed",
      data: { partId: "work", runId: "r", kind: "text", phase: "narration", value: "Working" },
    },
    {
      type: "content.completed",
      data: {
        partId: "answer",
        runId: "r",
        kind: "text",
        phase: "reply",
        value: '{"reply":"Hello"}',
      },
    },
    {
      type: "usage.recorded",
      data: { owner: { runId: "r" }, kind: "model", usage: { inputTokens: 100, outputTokens: 20 } },
    },
    { type: "model.settled", data: { runId: "r", outcome: "completed" } },
    { type: "model.requested", data: { runId: "other", owner: { turnId: "other-turn" } } },
    {
      type: "usage.recorded",
      data: {
        owner: { runId: "other" },
        kind: "model",
        usage: { inputTokens: 999, outputTokens: 999 },
      },
    },
    { type: "turn.settled", data: { turnId: "t", outcome: "completed" } },
  ];
  const events = facts.map((fact, line) => ({
    ...fact,
    at: "2026-01-01T00:00:00Z",
    scope: {},
    meta: { position: { line, index: 0 }, endOfLine: true },
  })) as ReceivedEvent[];
  return foldEvents(emptySessionView(), events);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selected = {};
  mocks.enabled = true;
  mocks.config.judgeMode = "ingest";
  mocks.ingest.mockResolvedValue({ trajectory_id: "s-t" });
});

it("builds the eve 1.0 distribution contract", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../dist/extension/_manifest.json", import.meta.url), "utf8"),
  );
  expect(manifest).toMatchObject({
    kind: "eve-extension",
    formatVersion: 3,
    builtWithEve: "1.0.0",
  });
});

it("reads only this turn's input, reply text and model usage from v27", () => {
  expect(captureTurn(snapshot(), "t")).toEqual({
    input: "Help me",
    reply: '{"reply":"Hello"}',
    inTok: 100,
    outTok: 20,
  });
});

it("chooses an arm once per turn, not once per model call", () => {
  armHook.events!["turn.started"]!({ data: { turnId: "t" } } as never, {} as never);
  const resolve = instructions as unknown as (ctx: { turn: { id: string } | null }) => unknown;
  expect(resolve({ turn: { id: "t" } })).toEqual({
    content: "For THIS reply, be warm\n\nJSON only",
  });
  expect(resolve({ turn: { id: "t" } })).toEqual({
    content: "For THIS reply, be warm\n\nJSON only",
  });
  expect(mocks.pick).toHaveBeenCalledTimes(1);
  expect(resolve({ turn: null })).toEqual({ content: "JSON only" });
});

async function settle(outcome = "completed", sessionId = "s") {
  await ingestHook.events!["turn.settled"]!(
    { data: { turnId: "t", outcome } } as never,
    { session: { id: sessionId }, view: snapshot() } as never,
  );
}

it("ingests a structured, session-keyed trajectory with correct arm and cost", async () => {
  mocks.selected.t = { arm: "warm" };
  await settle();
  expect(mocks.ingest).toHaveBeenCalledWith(
    "test",
    "live",
    expect.objectContaining({
      trajectory_id: "s-t",
      input: { subject: "Help me", body: "Help me" },
      output: { reply: "Hello" },
      labels: { "eval.config": "warm", "eval.source": "eve-dev" },
    }),
  );
  expect(mocks.ingest.mock.calls[0][2].cost_usd).toBeCloseTo(0.0006);
  expect(mocks.selected.t).toBeUndefined();
  await settle("completed", "other-session");
  expect(mocks.ingest.mock.calls[1][2].trajectory_id).toBe("other-session-t");
});

it.each(["failed", "cancelled"])(
  "does not grade a %s turn and clears its state",
  async (outcome) => {
    mocks.selected.t = { arm: "warm" };
    await settle(outcome);
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.runAndWait).not.toHaveBeenCalled();
    expect(mocks.selected.t).toBeUndefined();
  },
);

it("optional ingestion failure or missing credentials never fail the chat", async () => {
  mocks.ingest.mockRejectedValue(new Error("offline"));
  await expect(settle()).resolves.toBeUndefined();
  mocks.enabled = false;
  await expect(settle()).resolves.toBeUndefined();
  expect(mocks.ingest).toHaveBeenCalledTimes(1);
});

it("inline grading retains the hard policy floor and verified labels", async () => {
  mocks.config.judgeMode = "simple_judge";
  mocks.selected.t = { arm: "warm" };
  mocks.runAndWait.mockResolvedValue({
    trajectory_id: "judge-1",
    steps: {
      judge: {
        outputs: {
          average_score: 5,
          results: [{ raw_result: '{"policy_violation":true,"dimensions":{"clarity":4}}' }],
        },
      },
    },
  });
  await settle();
  expect(mocks.ingest).not.toHaveBeenCalled();
  expect(mocks.labels).toHaveBeenCalledWith(
    expect.anything(),
    "judge-1",
    expect.arrayContaining([
      ["eval.config", "warm"],
      ["eval.grade", "5.00"],
      ["eval.pass", "false"],
      ["eval.policy_violation", "true"],
      ["eval.dim.clarity", "4.0"],
    ]),
  );
});

describe("eval reporter", () => {
  it.each([
    { data: { answer: 42 }, reply: "ignored", output: { answer: 42 } },
    { data: undefined, reply: "text reply", output: "text reply" },
    { data: null, reply: "ignored", output: null },
  ])(
    "reports v1 output without losing structured null: $output",
    async ({ data, reply, output }) => {
      const ingestTrajectory = vi.fn().mockResolvedValue({ trajectory_id: "s" });
      const reporter = Jetty({ collection: "test", client: { ingestTrajectory } as never });
      reporter.onRunStart!([], {} as never);
      await reporter.onEvalComplete!({
        id: "eval-1",
        verdict: "passed",
        result: { sessionId: "s", status: "handled", data, reply },
        assertions: [
          { name: "grade", score: 0.8 },
          { name: "broken", errored: true },
        ],
      } as never);
      expect(ingestTrajectory).toHaveBeenCalledWith(
        "test",
        "eve-evals",
        expect.objectContaining({ trajectory_id: "s", output, scores: { grade: 0.8 } }),
      );
    },
  );
  it("omits trajectory IDs for sessionless executions sharing an eval ID", async () => {
    const ingestTrajectory = vi.fn().mockResolvedValue({ trajectory_id: "generated" });
    const reporter = Jetty({ collection: "test", client: { ingestTrajectory } as never });
    reporter.onRunStart!([], {} as never);
    for (let attempt = 0; attempt < 2; attempt++) {
      await reporter.onEvalComplete!({
        id: "eval-1",
        verdict: "failed",
        result: { status: "failed" },
        assertions: [],
      } as never);
    }
    expect(ingestTrajectory).toHaveBeenCalledTimes(2);
    for (const [, , payload] of ingestTrajectory.mock.calls) {
      expect(payload.eval_id).toBe("eval-1");
      expect(payload).not.toHaveProperty("trajectory_id");
    }
  });

  it("tolerates reporting failures", async () => {
    const ingestTrajectory = vi.fn().mockRejectedValue(new Error("offline"));
    const reporter = Jetty({ collection: "test", client: { ingestTrajectory } as never });
    reporter.onRunStart!([], {} as never);
    await expect(
      reporter.onEvalComplete!({
        id: "eval-1",
        verdict: "failed",
        result: { status: "failed" },
        assertions: [],
      } as never),
    ).resolves.toBeUndefined();
    expect(ingestTrajectory).toHaveBeenCalledTimes(1);
  });
});
