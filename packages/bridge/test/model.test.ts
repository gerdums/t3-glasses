import { describe, expect, it } from "vitest";
import { pendingRequest, threadAttention, threadDetail } from "../src/model.js";
import type { T3ThreadProjection, T3ThreadShell } from "../src/t3types.js";

const shell = (over: Partial<T3ThreadShell> = {}): T3ThreadShell => ({
  id: "t1",
  projectId: "p1",
  title: "Fix login",
  status: "idle",
  updatedAt: "2026-10-09T00:00:00.000Z",
  ...over,
});

describe("attention", () => {
  it("ranks pending requests above run state", () => {
    expect(threadAttention(shell({ pendingRuntimeRequest: { id: "r", kind: "command", createdAt: "" } }))).toBe("approval");
    expect(threadAttention(shell({ pendingRuntimeRequest: { id: "r", kind: "user_input", createdAt: "" } }))).toBe("question");
  });
  it("treats a live run as running even when the thread status lags", () => {
    expect(threadAttention(shell({ status: "cancelled", activityRunStatus: "running" }))).toBe("running");
    expect(threadAttention(shell({ status: "idle", activeRunId: "run1" }))).toBe("running");
  });
  it("reports failures and finished work until settled", () => {
    expect(threadAttention(shell({ status: "failed" }))).toBe("failed");
    expect(threadAttention(shell({ status: "completed" }))).toBe("done");
    expect(threadAttention(shell({ status: "completed", settledOverride: "settled" }))).toBe("idle");
  });
});

const projection = (over: Partial<T3ThreadProjection> = {}): T3ThreadProjection => ({
  thread: shell(),
  runs: [{ id: "run1", status: "running" }],
  runtimeRequests: [{ id: "req1", kind: "command", status: "pending", createdAt: "2026-10-09T00:00:01.000Z" }],
  messages: [
    { id: "m1", role: "user", text: "Run the tests", updatedAt: "a" },
    { id: "m2", role: "assistant", text: "", updatedAt: "b" },
    { id: "m3", role: "assistant", text: "On it.", updatedAt: "c" },
  ],
  turnItems: [
    { id: "i1", type: "command_execution", status: "running", input: "npm test" },
    {
      id: "i2",
      type: "approval_request",
      requestId: "req1",
      requestKind: "command",
      prompt: "npm test",
      options: [
        { decision: "accept", label: "Yes" },
        { decision: "bogus", label: "Ignored" },
      ],
    },
  ],
  ...over,
});

describe("thread detail", () => {
  it("extracts the pending approval with only valid decisions", () => {
    expect(pendingRequest(projection())).toEqual({
      kind: "approval",
      requestId: "req1",
      requestKind: "command",
      prompt: "npm test",
      options: [{ decision: "accept", label: "Yes" }],
    });
  });
  it("extracts questions with their options", () => {
    const detail = pendingRequest(
      projection({
        runtimeRequests: [{ id: "q1", kind: "user_input", status: "pending", createdAt: "" }],
        turnItems: [
          { id: "i", type: "user_input_request", requestId: "q1", questions: [{ id: "where", question: "Where?", options: [{ label: "M4" }] }] },
        ],
      }),
    );
    expect(detail).toEqual({
      kind: "question",
      requestId: "q1",
      questions: [{ id: "where", question: "Where?", options: [{ label: "M4" }], multiSelect: false }],
    });
  });
  it("merges shell state, drops empty messages, and shows live activity", () => {
    const detail = threadDetail(projection(), { id: "env", label: "M4" }, new Map([["p1", { id: "p1", title: "t3code" }]]), shell({ status: "running" }));
    expect(detail.projectTitle).toBe("t3code");
    expect(detail.attention).toBe("approval");
    expect(detail.messages.map((m) => m.text)).toEqual(["Run the tests", "On it."]);
    expect(detail.activity).toBe("$ npm test");
    expect(detail.canInterrupt).toBe(true);
  });
});
