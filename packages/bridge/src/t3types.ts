/**
 * The parts of T3 Code's orchestration protocol 2 that the bridge reads.
 * Field names mirror packages/contracts/src/orchestrationV2.ts upstream; every
 * field the bridge does not need is left out, and optional where servers vary.
 */

export interface T3Project {
  id: string;
  title: string;
}

export interface T3PendingRuntimeRequestSummary {
  id: string;
  kind: string;
  createdAt: string;
}

export interface T3LatestVisibleMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  updatedAt: string;
}

export interface T3ThreadShell {
  id: string;
  projectId: string;
  title: string;
  /** Absent on the thread inside a projection; present on shell threads. */
  status?: string;
  activeRunId?: string | null;
  /** Live status of the run currently doing work, when there is one. */
  activityRunStatus?: string | null;
  latestRunId?: string | null;
  pendingRuntimeRequest?: T3PendingRuntimeRequestSummary | null;
  latestVisibleMessage?: T3LatestVisibleMessage | null;
  lineage?: { parentThreadId: string | null; relationshipToParent?: string | null } | null;
  activeProviderThreadId?: string | null;
  latestRunRequestedAt?: string | null;
  latestRunStartedAt?: string | null;
  latestRunCompletedAt?: string | null;
  latestUserMessageAt?: string | null;
  /** Absent on older servers; null when the user never sent a message. */
  latestUserAuthoredMessageAt?: string | null;
  interactionMode?: string;
  hasActionableProposedPlan?: boolean;
  pendingBackgroundTasks?: { kind: string }[];
  pinnedAt?: string | null;
  pinOrderKey?: string | null;
  activeOrderKey?: string | null;
  unsettledAt?: string | null;
  snoozedAt?: string | null;
  settledOverride?: "settled" | "unsettled" | null;
  settledAt?: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
  snoozedUntil?: string | null;
  updatedAt: string;
  createdAt?: string;
}

export interface T3ShellSnapshot {
  snapshotSequence: number;
  projects: T3Project[];
  threads: T3ThreadShell[];
}

export type T3ShellStreamItem =
  | { kind: "synchronized" }
  | { kind: "snapshot"; snapshot: T3ShellSnapshot; resolvedRepositoryIdentityRoots?: string[] }
  | { kind: "project.updated"; sequence: number; project: T3Project }
  | { kind: "project.removed"; sequence: number; projectId: string }
  | { kind: "thread.updated"; sequence: number; location: "active" | "archive"; thread: T3ThreadShell }
  | { kind: "thread.removed"; sequence: number; location: "active" | "archive"; threadId: string };

export interface T3Run {
  id: string;
  status: string;
}

export interface T3RuntimeRequest {
  id: string;
  kind: string;
  status: "pending" | "resolved" | "expired" | "cancelled";
  createdAt: string;
}

export interface T3Message {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt?: string;
  updatedAt?: string;
  notification?: unknown;
  streaming?: boolean;
}

export interface T3ApprovalOption {
  decision: string;
  label: string;
}

export interface T3Question {
  id: string;
  header?: string;
  question: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export interface T3TurnItem {
  id: string;
  type: string;
  status?: string;
  title?: string | null;
  startedAt?: string | null;
  updatedAt?: string;
  // approval_request
  requestId?: string;
  requestKind?: string;
  prompt?: string;
  appName?: string;
  options?: T3ApprovalOption[];
  // user_input_request
  questions?: T3Question[];
  // command_execution
  input?: string;
}

export interface T3ThreadProjection {
  thread: T3ThreadShell;
  runs: T3Run[];
  runtimeRequests: T3RuntimeRequest[];
  messages: T3Message[];
  turnItems: T3TurnItem[];
}
