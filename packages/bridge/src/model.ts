/**
 * Pure functions that turn T3 orchestration data into the small, attention-
 * sorted shapes the glasses display.
 */
import {
  type ApprovalDecision,
  type ApprovalOption,
  type Attention,
  type AttentionCounts,
  type PendingRequest,
  type ThreadDetail,
  type ThreadMessage,
  type ThreadSection,
  type ThreadSummary,
} from "@t3-glasses/protocol";
import type { T3Project, T3ThreadProjection, T3ThreadShell, T3TurnItem } from "./t3types.js";

const RUNNING_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const ACTIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);
const APPROVAL_DECISIONS = new Set<ApprovalDecision>([
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel",
]);
const DEFAULT_APPROVAL_OPTIONS: ApprovalOption[] = [
  { decision: "accept", label: "Approve" },
  { decision: "acceptForSession", label: "Approve for session" },
  { decision: "decline", label: "Deny" },
];

export const MESSAGE_LIMIT = 8;
export const MESSAGE_CHARS = 700;
export const PREVIEW_CHARS = 80;

export function isSettled(thread: T3ThreadShell): boolean {
  if (thread.settledOverride === "settled") return true;
  if (thread.settledOverride === "unsettled") return false;
  return Boolean(thread.settledAt);
}

export function isWorking(thread: T3ThreadShell): boolean {
  return (
    RUNNING_STATUSES.has(thread.status ?? "") ||
    RUNNING_STATUSES.has(thread.activityRunStatus ?? "") ||
    Boolean(thread.activeRunId)
  );
}

export function threadAttention(thread: T3ThreadShell): Attention {
  const pending = thread.pendingRuntimeRequest;
  if (pending) return pending.kind === "user_input" ? "question" : "approval";
  if (isWorking(thread)) return "running";
  if (isSettled(thread)) return "idle";
  if (thread.status === "failed") return "failed";
  if (thread.status === "completed" || thread.status === "interrupted") return "done";
  return "idle";
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

export function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 3).trimEnd()}...` : trimmed;
}

export function summarizeThread(
  thread: T3ThreadShell,
  env: { id: string; label: string },
  projects: ReadonlyMap<string, T3Project>,
  section: ThreadSection = "active",
): ThreadSummary {
  const latest = thread.latestVisibleMessage;
  return {
    envId: env.id,
    envLabel: env.label,
    id: thread.id,
    title: thread.title,
    projectTitle: projects.get(thread.projectId)?.title ?? "",
    status: isWorking(thread) ? "running" : thread.status ?? "idle",
    attention: threadAttention(thread),
    section,
    updatedAt: latest?.updatedAt && latest.updatedAt > thread.updatedAt ? latest.updatedAt : thread.updatedAt,
    ...(latest?.text ? { preview: oneLine(latest.text, PREVIEW_CHARS) } : {}),
  };
}

export function countAttention(threads: Iterable<ThreadSummary>): AttentionCounts {
  const counts: AttentionCounts = { approval: 0, question: 0, failed: 0, running: 0 };
  for (const thread of threads) {
    if (thread.attention in counts) counts[thread.attention as keyof AttentionCounts] += 1;
  }
  return counts;
}

function latestItem(items: T3TurnItem[], predicate: (item: T3TurnItem) => boolean): T3TurnItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (predicate(item)) return item;
  }
  return undefined;
}

export function pendingRequest(projection: T3ThreadProjection): PendingRequest | undefined {
  const pending = [...projection.runtimeRequests]
    .filter((request) => request.status === "pending")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!pending) return undefined;
  const item = latestItem(projection.turnItems, (candidate) => candidate.requestId === pending.id);

  if (pending.kind === "user_input") {
    const questions = (item?.questions ?? []).map((question) => ({
      id: question.id,
      ...(question.header ? { header: question.header } : {}),
      question: question.question,
      options: (question.options ?? []).map((option) => ({
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
      multiSelect: Boolean(question.multiSelect),
    }));
    return { kind: "question", requestId: pending.id, questions };
  }

  const advertised = (item?.options ?? []).filter((option): option is ApprovalOption =>
    APPROVAL_DECISIONS.has(option.decision as ApprovalDecision),
  );
  const prompt = item?.prompt || item?.title || (item?.appName ? `${item.appName} wants access` : "");
  return {
    kind: "approval",
    requestId: pending.id,
    requestKind: item?.requestKind ?? pending.kind,
    prompt: clip(prompt || `The agent requests ${pending.kind} permission`, MESSAGE_CHARS),
    options: advertised.length > 0 ? advertised : DEFAULT_APPROVAL_OPTIONS,
  };
}

export function activeRunId(projection: T3ThreadProjection): string | undefined {
  for (let index = projection.runs.length - 1; index >= 0; index -= 1) {
    const run = projection.runs[index]!;
    if (ACTIVE_RUN_STATUSES.has(run.status)) return run.id;
  }
  return undefined;
}

export function activityLine(projection: T3ThreadProjection): string | undefined {
  const item = latestItem(projection.turnItems, (candidate) => candidate.status === "running");
  if (!item) return undefined;
  if (item.type === "command_execution" && item.input) return oneLine(`$ ${item.input}`, 120);
  if (item.type === "reasoning") return "Thinking...";
  if (item.title) return oneLine(item.title, 120);
  return oneLine(item.type.replace(/_/g, " "), 120);
}

export function recentMessages(projection: T3ThreadProjection, limit = MESSAGE_LIMIT): ThreadMessage[] {
  return projection.messages
    .filter((message) => message.text.trim().length > 0)
    .slice(-limit)
    .map((message) => ({
      role: message.notification ? "system" : message.role,
      text: clip(message.text, MESSAGE_CHARS),
      at: message.updatedAt ?? message.createdAt ?? "",
    }));
}

/**
 * `shell` is the environment's shell entry for the thread: the projection's
 * own thread object omits status and pending-request summaries.
 */
export function threadDetail(
  projection: T3ThreadProjection,
  env: { id: string; label: string },
  projects: ReadonlyMap<string, T3Project>,
  shell?: T3ThreadShell,
  section?: ThreadSection,
): ThreadDetail {
  const summary = summarizeThread({ ...projection.thread, ...shell }, env, projects, section);
  const pending = pendingRequest(projection);
  const runId = activeRunId(projection);
  const activity = runId ? activityLine(projection) : undefined;
  return {
    ...summary,
    // The projection is fresher than the shell for attention.
    attention: pending
      ? pending.kind === "question" ? "question" : "approval"
      : runId ? "running" : summary.attention,
    status: runId ? "running" : summary.status,
    messages: recentMessages(projection),
    ...(activity ? { activity } : {}),
    ...(pending ? { pending } : {}),
    canInterrupt: Boolean(runId),
  };
}
