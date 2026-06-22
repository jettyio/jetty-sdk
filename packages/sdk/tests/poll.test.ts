import { describe, expect, it } from "vitest";
import { isTerminalStatus, JettyError, parseWorkflowId } from "../src/index.js";

describe("parseWorkflowId", () => {
  it("extracts the trajectoryId after the last --", () => {
    const r = parseWorkflowId("acme-triage--a1b2c3d4");
    expect(r.trajectoryId).toBe("a1b2c3d4");
    expect(r.collection).toBe("acme");
    expect(r.task).toBe("triage");
  });

  it("keeps dashes in the task name (best-effort left split)", () => {
    const r = parseWorkflowId("acme-my-task--deadbeef");
    expect(r.trajectoryId).toBe("deadbeef");
    expect(r.collection).toBe("acme");
    expect(r.task).toBe("my-task");
  });

  it("uses the LAST -- so a trajectoryId is always recoverable", () => {
    const r = parseWorkflowId("a-b--c--d12345");
    expect(r.trajectoryId).toBe("d12345");
  });

  it("throws JettyError when the separator is missing", () => {
    expect(() => parseWorkflowId("no-separator-here")).toThrow(JettyError);
  });
});

describe("isTerminalStatus", () => {
  it("classifies terminal vs in-flight statuses", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
    expect(isTerminalStatus("archived")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus("pending")).toBe(false);
  });
});
