/**
 * T3 Code's thread list order, ported from its shared client runtime so the
 * glasses list threads exactly like the T3 web, desktop, and mobile apps:
 *
 *   Pinned → Active → Working (beta) → Snoozed → Settled
 *
 * Sources (pingdotgg/t3code, packages/client-runtime/src/state):
 *   models.ts         presentThreadShell / shellRuntime
 *   threadInbox.ts    isThreadWorking, sortInboxThreadsByReturn,
 *                     sortWorkingThreadsBySend, createInboxReturnTracker
 *   threadSort.ts     sortPinnedThreadsByOrderKey, sortActiveThreadsByOrderKey,
 *                     sortSettledThreads, resolveSettledThreadTimestamp
 *   threadSettled.ts  effectiveSnoozed, threadRaisedHandWhileSnoozed
 * and apps/mobile/src/features/threads/threadListV2.ts for section assignment.
 */
import type { ThreadSection } from "@t3-glasses/protocol";
import type { T3ThreadShell } from "./t3types.js";

/** A shell plus the environment it came from; thread ids are unique per environment only. */
export interface ScopedShell {
  environmentId: string;
  shell: T3ThreadShell;
}

const ACTIVE_RUNTIME = new Set(["preparing", "queued", "starting", "running", "waiting"]);

const toMs = (value: string | null | undefined): number | null => {
  if (value == null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

// ---- Derived state (models.ts) --------------------------------------------------

/** Background work that wakes the agent keeps a finished run "parked" rather than done. */
function backgroundWorkHoldsCompletion(tasks: T3ThreadShell["pendingBackgroundTasks"]): boolean {
  return (tasks ?? []).some((task) => task.kind !== "command");
}

interface Runtime {
  status: string;
  activeRunId: string | null;
  updatedAt: string;
}

function runtimeOf(t: T3ThreadShell): Runtime | null {
  const parked = backgroundWorkHoldsCompletion(t.pendingBackgroundTasks) && t.status !== "failed";
  if ((t.latestRunId ?? null) === null && (t.activeProviderThreadId ?? null) === null && !parked) return null;
  return {
    status: parked ? "idle" : (t.activityRunStatus ?? t.status ?? "idle"),
    activeRunId: t.activeRunId ?? null,
    updatedAt: t.updatedAt,
  };
}

interface LatestRun {
  runId: string;
  status: string;
  requestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

const TERMINAL_STATUSES = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);

function latestRunOf(t: T3ThreadShell): LatestRun | null {
  if (!t.latestRunId) return null;
  const status = t.status === "idle" ? "completed" : (t.status ?? "completed");
  const settledStatus = t.status === "idle" || TERMINAL_STATUSES.has(t.status ?? "");
  return {
    runId: t.latestRunId,
    status,
    requestedAt: t.latestRunRequestedAt ?? null,
    startedAt: t.latestRunStartedAt ?? null,
    completedAt: t.latestRunCompletedAt !== undefined ? t.latestRunCompletedAt : settledStatus ? t.updatedAt : null,
  };
}

const hasPendingApprovals = (t: T3ThreadShell) =>
  t.pendingRuntimeRequest != null &&
  t.pendingRuntimeRequest.kind !== "user_input" &&
  t.pendingRuntimeRequest.kind !== "auth_refresh";
const hasPendingUserInput = (t: T3ThreadShell) => t.pendingRuntimeRequest?.kind === "user_input";

// ---- Classification (threadInbox.ts, threadSettled.ts) -------------------------------

/** Busy with work that doesn't need the user: running, or parked on background work. */
export function isThreadWorking(t: T3ThreadShell): boolean {
  if (hasPendingApprovals(t) || hasPendingUserInput(t)) return false;
  const runtime = runtimeOf(t);
  if (!(runtime && ACTIVE_RUNTIME.has(runtime.status)) && runtime?.status !== "idle") return false;
  const run = latestRunOf(t);
  const runSettled = run !== null && !ACTIVE_RUNTIME.has(run.status) && runtime?.activeRunId !== run.runId;
  return !(t.interactionMode === "plan" && t.hasActionableProposedPlan && runSettled);
}

function raisedHandWhileSnoozed(t: T3ThreadShell): boolean {
  if (hasPendingApprovals(t) || hasPendingUserInput(t)) return true;
  const runtime = runtimeOf(t);
  if (
    (runtime?.status === "error" || runtime?.status === "failed") &&
    (t.snoozedAt == null || Date.parse(runtime.updatedAt) > Date.parse(t.snoozedAt))
  ) {
    return true;
  }
  const run = latestRunOf(t);
  return (
    t.snoozedAt != null &&
    run?.status === "completed" &&
    run.completedAt != null &&
    Date.parse(run.completedAt) > Date.parse(t.snoozedAt)
  );
}

export function effectiveSnoozed(t: T3ThreadShell, now = Date.now()): boolean {
  const wake = toMs(t.snoozedUntil);
  if (wake === null || wake <= now) return false;
  return !raisedHandWhileSnoozed(t);
}

/** Archived threads and subagents never appear in the list. */
export function isListed(t: T3ThreadShell): boolean {
  if (t.archivedAt || t.deletedAt) return false;
  return t.lineage?.relationshipToParent !== "subagent";
}

/** First matching rule wins (threadListV2.ts). */
export function sectionOf(t: T3ThreadShell, workingEnabled: boolean, now = Date.now()): ThreadSection {
  if (effectiveSnoozed(t, now)) return "snoozed";
  if (t.settledOverride === "settled") return "settled";
  if (t.pinnedAt != null) return "pinned";
  if (workingEnabled && isThreadWorking(t)) return "working";
  return "active";
}

// ---- Ordering (threadSort.ts, threadInbox.ts) --------------------------------------

const identity = (a: ScopedShell, b: ScopedShell) =>
  a.shell.id.localeCompare(b.shell.id) || a.environmentId.localeCompare(b.environmentId);

function newestFirst(items: ScopedShell[], time: (item: ScopedShell) => number): ScopedShell[] {
  const keys = new Map(items.map((item) => [item, time(item)]));
  return [...items].sort((a, b) => keys.get(b)! - keys.get(a)! || identity(a, b));
}

/** User-arranged keys first (plain string order), then keyless newest-created first. */
export function sortPinned(items: ScopedShell[]): ScopedShell[] {
  const keyed = items.filter((item) => item.shell.pinOrderKey != null);
  const keyless = items.filter((item) => item.shell.pinOrderKey == null);
  keyed.sort((a, b) => {
    const ka = a.shell.pinOrderKey!;
    const kb = b.shell.pinOrderKey!;
    return ka < kb ? -1 : ka > kb ? 1 : identity(a, b);
  });
  return [...keyed, ...newestFirst(keyless, (item) => toMs(item.shell.createdAt) ?? 0)];
}

/** Beta off: new and reopened threads lead; arranged threads follow their saved keys. */
export function sortActiveByOrderKey(items: ScopedShell[]): ScopedShell[] {
  const anchor = (item: ScopedShell) =>
    Math.max(toMs(item.shell.createdAt) ?? 0, toMs(item.shell.unsettledAt) ?? 0);
  return [...items].sort((a, b) => {
    const ka = a.shell.activeOrderKey;
    const kb = b.shell.activeOrderKey;
    if (ka == null && kb != null) return -1;
    if (ka != null && kb == null) return 1;
    const order = ka != null && kb != null ? (ka < kb ? -1 : ka > kb ? 1 : 0) : anchor(b) - anchor(a);
    return order || identity(a, b);
  });
}

/** Beta on: newest first by when each thread last came back to the user. */
export function sortInboxByReturn(items: ScopedShell[], returnedAt: (item: ScopedShell) => number | undefined): ScopedShell[] {
  return newestFirst(items, (item) => {
    const run = latestRunOf(item.shell);
    return Math.max(
      toMs(item.shell.createdAt) ?? 0,
      toMs(item.shell.unsettledAt) ?? 0,
      toMs(run?.requestedAt) ?? 0,
      toMs(run?.completedAt) ?? 0,
      returnedAt(item) ?? 0,
    );
  });
}

/** Working: newest first by the last message the user sent, so rows stay put while agents work. */
export function sortWorkingBySend(items: ScopedShell[]): ScopedShell[] {
  return newestFirst(items, (item) => {
    const sent =
      item.shell.latestUserAuthoredMessageAt === undefined
        ? latestRunOf(item.shell)?.requestedAt
        : item.shell.latestUserAuthoredMessageAt;
    return Math.max(toMs(item.shell.createdAt) ?? 0, toMs(sent) ?? 0);
  });
}

/** Soonest wake first. */
export function sortSnoozed(items: ScopedShell[]): ScopedShell[] {
  return [...items].sort(
    (a, b) => (toMs(a.shell.snoozedUntil) ?? 0) - (toMs(b.shell.snoozedUntil) ?? 0) || identity(a, b),
  );
}

function settledTimestamp(t: T3ThreadShell): number {
  const settled = toMs(t.settledAt);
  if (settled !== null) return settled;
  const run = latestRunOf(t);
  let latest: number | null = null;
  for (const candidate of [t.latestUserMessageAt, run?.requestedAt, run?.startedAt, run?.completedAt]) {
    const ms = toMs(candidate);
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  }
  return latest ?? toMs(t.updatedAt) ?? 0;
}

/** History: newest-ended first, id tiebreak. */
export function sortSettled(items: ScopedShell[]): ScopedShell[] {
  const keys = new Map(items.map((item) => [item, settledTimestamp(item.shell)]));
  return [...items].sort((a, b) => keys.get(b)! - keys.get(a)! || a.shell.id.localeCompare(b.shell.id));
}

// ---- Inbox return tracking (createInboxReturnTracker) --------------------------------

/**
 * Remembers when each thread left Working; the server never stamps this. The
 * first observation only takes a baseline so a restart doesn't reshuffle.
 */
export class InboxReturnTracker {
  private lastWorking: Set<string> | null = null;
  private readonly returns = new Map<string, number>();

  static key(item: ScopedShell): string {
    return `${item.environmentId}:${item.shell.id}`;
  }

  observe(items: ScopedShell[] | null, now = Date.now()): void {
    if (items === null) {
      this.lastWorking = null;
      this.returns.clear();
      return;
    }
    const working = new Set<string>();
    const present = new Set<string>();
    for (const item of items) {
      const key = InboxReturnTracker.key(item);
      present.add(key);
      if (isThreadWorking(item.shell)) working.add(key);
    }
    for (const key of this.returns.keys()) if (!present.has(key)) this.returns.delete(key);
    for (const key of this.lastWorking ?? []) {
      if (present.has(key) && !working.has(key)) this.returns.set(key, now);
    }
    this.lastWorking = working;
  }

  returnedAt = (item: ScopedShell): number | undefined => this.returns.get(InboxReturnTracker.key(item));
}

// ---- Whole list ---------------------------------------------------------------------

export type SectionedThreads = Record<ThreadSection, ScopedShell[]>;

export function buildSections(
  items: ScopedShell[],
  options: { workingEnabled: boolean; tracker: InboxReturnTracker; now?: number },
): SectionedThreads {
  const now = options.now ?? Date.now();
  const listed = items.filter((item) => isListed(item.shell));
  options.tracker.observe(options.workingEnabled ? listed : null, now);
  const groups: SectionedThreads = { pinned: [], active: [], working: [], snoozed: [], settled: [] };
  for (const item of listed) groups[sectionOf(item.shell, options.workingEnabled, now)].push(item);
  return {
    pinned: sortPinned(groups.pinned),
    active: options.workingEnabled
      ? sortInboxByReturn(groups.active, options.tracker.returnedAt)
      : sortActiveByOrderKey(groups.active),
    working: sortWorkingBySend(groups.working),
    snoozed: sortSnoozed(groups.snoozed),
    settled: sortSettled(groups.settled),
  };
}

export const SECTION_ORDER: readonly ThreadSection[] = ["pinned", "active", "working", "snoozed", "settled"];
