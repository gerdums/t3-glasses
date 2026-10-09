import { describe, expect, it } from "vitest";
import { InboxReturnTracker, buildSections, isThreadWorking, sectionOf, type ScopedShell } from "../src/sections.js";
import type { T3ThreadShell } from "../src/t3types.js";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const shell = (id: string, over: Partial<T3ThreadShell> = {}): T3ThreadShell => ({
  id,
  projectId: "p",
  title: id,
  status: "idle",
  createdAt: at(600),
  updatedAt: at(600),
  latestRunId: null,
  ...over,
});
const scoped = (shells: T3ThreadShell[], env = "e1"): ScopedShell[] => shells.map((s) => ({ environmentId: env, shell: s }));
const ids = (items: ScopedShell[]) => items.map((item) => item.shell.id);

describe("section assignment", () => {
  it("applies T3's first-match rules", () => {
    expect(sectionOf(shell("a", { snoozedUntil: at(-60), snoozedAt: at(10), settledOverride: "settled" }), true, NOW)).toBe("snoozed");
    expect(sectionOf(shell("b", { settledOverride: "settled", pinnedAt: at(5) }), true, NOW)).toBe("settled");
    expect(sectionOf(shell("c", { pinnedAt: at(5), status: "running", latestRunId: "r" }), true, NOW)).toBe("pinned");
    expect(sectionOf(shell("d", { status: "running", latestRunId: "r", activeRunId: "r" }), true, NOW)).toBe("working");
    expect(sectionOf(shell("d", { status: "running", latestRunId: "r", activeRunId: "r" }), false, NOW)).toBe("active");
  });
  it("wakes a snoozed thread that needs the user or whose snooze expired", () => {
    const pending = { id: "q", kind: "user_input", createdAt: at(1) };
    expect(sectionOf(shell("a", { snoozedUntil: at(-60), snoozedAt: at(10), pendingRuntimeRequest: pending }), true, NOW)).toBe("active");
    expect(sectionOf(shell("b", { snoozedUntil: at(5), snoozedAt: at(60) }), true, NOW)).toBe("active");
  });
  it("keeps approvals, questions, and plan prompts out of Working", () => {
    const running = { status: "running", latestRunId: "r", activeRunId: "r" };
    expect(isThreadWorking(shell("a", { ...running, pendingRuntimeRequest: { id: "x", kind: "command", createdAt: at(1) } }))).toBe(false);
    expect(isThreadWorking(shell("b", { status: "completed", latestRunId: "r", interactionMode: "plan", hasActionableProposedPlan: true, pendingBackgroundTasks: [{ kind: "subagent" }] }))).toBe(false);
    // Parked on background work that will wake it.
    expect(isThreadWorking(shell("c", { status: "completed", latestRunId: "r", pendingBackgroundTasks: [{ kind: "monitor" }] }))).toBe(true);
    expect(isThreadWorking(shell("d", { status: "completed", latestRunId: "r", pendingBackgroundTasks: [{ kind: "command" }] }))).toBe(false);
  });
  it("hides archived threads and subagents", () => {
    const sections = buildSections(
      scoped([shell("a", { archivedAt: at(1) }), shell("b", { lineage: { parentThreadId: "x", relationshipToParent: "subagent" } }), shell("c")]),
      { workingEnabled: true, tracker: new InboxReturnTracker(), now: NOW },
    );
    expect(Object.values(sections).flat().map((item) => item.shell.id)).toEqual(["c"]);
  });
});

describe("ordering", () => {
  it("orders pinned by key, then keyless newest-created", () => {
    const sections = buildSections(
      scoped([
        shell("old", { pinnedAt: at(1), createdAt: at(300) }),
        shell("b", { pinnedAt: at(1), pinOrderKey: "n" }),
        shell("new", { pinnedAt: at(1), createdAt: at(30) }),
        shell("a", { pinnedAt: at(1), pinOrderKey: "c" }),
      ]),
      { workingEnabled: false, tracker: new InboxReturnTracker(), now: NOW },
    );
    expect(ids(sections.pinned)).toEqual(["a", "b", "new", "old"]);
  });

  it("beta off: unkeyed newest first, then saved active keys", () => {
    const sections = buildSections(
      scoped([
        shell("keyed-b", { activeOrderKey: "m" }),
        shell("fresh", { createdAt: at(5) }),
        shell("keyed-a", { activeOrderKey: "b" }),
        shell("reopened", { createdAt: at(900), unsettledAt: at(2) }),
      ]),
      { workingEnabled: false, tracker: new InboxReturnTracker(), now: NOW },
    );
    expect(ids(sections.active)).toEqual(["reopened", "fresh", "keyed-a", "keyed-b"]);
  });

  it("beta on: inbox by return time, Working by last send", () => {
    const sections = buildSections(
      scoped([
        shell("asked-earlier", { latestRunId: "r1", status: "completed", latestRunCompletedAt: at(30), activeOrderKey: "a" }),
        shell("just-finished", { latestRunId: "r2", status: "completed", latestRunCompletedAt: at(1), activeOrderKey: "z" }),
        shell("working-old-send", { status: "running", latestRunId: "r3", activeRunId: "r3", latestUserAuthoredMessageAt: at(50) }),
        shell("working-new-send", { status: "running", latestRunId: "r4", activeRunId: "r4", latestUserAuthoredMessageAt: at(3) }),
      ]),
      { workingEnabled: true, tracker: new InboxReturnTracker(), now: NOW },
    );
    expect(ids(sections.active)).toEqual(["just-finished", "asked-earlier"]);
    expect(ids(sections.working)).toEqual(["working-new-send", "working-old-send"]);
  });

  it("settled newest-ended first, snoozed soonest wake first", () => {
    const sections = buildSections(
      scoped([
        shell("s-old", { settledOverride: "settled", settledAt: at(100) }),
        shell("s-new", { settledOverride: "settled", settledAt: at(10) }),
        shell("z-late", { snoozedUntil: at(-120), snoozedAt: at(5) }),
        shell("z-soon", { snoozedUntil: at(-10), snoozedAt: at(5) }),
      ]),
      { workingEnabled: true, tracker: new InboxReturnTracker(), now: NOW },
    );
    expect(ids(sections.settled)).toEqual(["s-new", "s-old"]);
    expect(ids(sections.snoozed)).toEqual(["z-soon", "z-late"]);
  });

  it("puts a thread that just left Working at the top of the inbox", () => {
    const tracker = new InboxReturnTracker();
    const working = shell("w", { status: "running", latestRunId: "r", activeRunId: "r", createdAt: at(900) });
    const other = shell("o", { createdAt: at(20) });
    buildSections(scoped([working, other]), { workingEnabled: true, tracker, now: NOW - 60_000 }); // baseline
    const done = { ...working, status: "completed", activeRunId: null, activityRunStatus: null, latestRunCompletedAt: at(900) };
    const sections = buildSections(scoped([done, other]), { workingEnabled: true, tracker, now: NOW });
    expect(ids(sections.active)).toEqual(["w", "o"]);
  });
});
