/**
 * Wire contract between the t3-glasses bridge (runs on your computer) and the
 * Even Hub glasses app (runs in the Even app's WebView on your phone).
 *
 * Every request carries `Authorization: Bearer <glasses token>`. The event
 * stream also accepts `?token=` because EventSource cannot set headers.
 */

export const PROTOCOL_VERSION = 1;

/** Why a thread wants the wearer's eyes, most urgent first. */
export type Attention =
  | "approval" // a tool or permission request is waiting for a decision
  | "question" // the agent asked the user something
  | "failed" // the latest run failed
  | "running" // work is in progress
  | "done" // finished and not yet settled
  | "idle";

export const ATTENTION_ORDER: readonly Attention[] = [
  "approval",
  "question",
  "failed",
  "running",
  "done",
  "idle",
];

export interface AttentionCounts {
  approval: number;
  question: number;
  failed: number;
  running: number;
}

export interface EnvSummary {
  id: string;
  label: string;
  /** True while the bridge holds a live subscription to the environment. */
  connected: boolean;
  /** Human-readable reason when not connected. */
  error?: string;
  attention: AttentionCounts;
  /** Active (unsettled, unarchived) thread count. */
  threadCount: number;
}

export interface ThreadSummary {
  envId: string;
  envLabel: string;
  id: string;
  title: string;
  projectTitle: string;
  /** Raw T3 thread status, such as "running" or "idle". */
  status: string;
  attention: Attention;
  /** ISO timestamp of the latest change. */
  updatedAt: string;
  /** Short single-line preview of the latest visible message, if any. */
  preview?: string;
}

export interface ThreadMessage {
  role: "user" | "assistant" | "system";
  text: string;
  /** ISO timestamp. */
  at: string;
}

export interface ApprovalOption {
  decision: ApprovalDecision;
  label: string;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  id: string;
  header?: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export type PendingRequest =
  | {
      kind: "approval";
      requestId: string;
      /** command, file-read, file-change, mcp-elicitation, permission */
      requestKind: string;
      /** What the agent wants to do, such as the command line. */
      prompt: string;
      options: ApprovalOption[];
    }
  | {
      kind: "question";
      requestId: string;
      questions: Question[];
    };

export interface ThreadDetail extends ThreadSummary {
  /** Most recent visible messages, oldest first. */
  messages: ThreadMessage[];
  /** Latest tool activity line while running, such as "$ npm test". */
  activity?: string;
  pending?: PendingRequest;
  canInterrupt: boolean;
}

// ---- Requests -------------------------------------------------------------

export type SendMode = "auto" | "queue";

export interface SendMessageRequest {
  text: string;
  /** auto steers or starts; queue waits for the active turn. Default auto. */
  mode?: SendMode;
}

export interface ApprovalRequest {
  requestId: string;
  decision: ApprovalDecision;
}

export interface AnswerRequest {
  requestId: string;
  /** Question id -> chosen option label (or free text). */
  answers: Record<string, string>;
}

export interface OkResponse {
  ok: true;
}

export interface ErrorResponse {
  ok: false;
  error: string;
}

export interface HealthResponse {
  ok: true;
  version: string;
  protocol: number;
  /** Whether POST /api/transcribe is configured. */
  transcription: boolean;
}

export interface TranscribeResponse {
  text: string;
}

/** Server-sent event payloads on GET /api/events (event name = type). */
export type BridgeEvent =
  | { type: "envs"; envs: EnvSummary[] }
  | { type: "thread"; envId: string; threadId: string; attention: Attention };

/**
 * Routes, relative to the bridge base URL.
 *
 * GET  /api/health                                   -> HealthResponse
 * GET  /api/envs                                     -> { envs: EnvSummary[] }
 * GET  /api/threads?env=<id>&limit=<n>               -> { threads: ThreadSummary[] }
 *      Omit env for an all-environment inbox sorted by attention.
 * GET  /api/envs/:env/threads/:thread                -> ThreadDetail
 * POST /api/envs/:env/threads/:thread/messages       SendMessageRequest -> OkResponse
 * POST /api/envs/:env/threads/:thread/approval       ApprovalRequest    -> OkResponse
 * POST /api/envs/:env/threads/:thread/answer         AnswerRequest      -> OkResponse
 * POST /api/envs/:env/threads/:thread/interrupt      (empty)            -> OkResponse
 * POST /api/transcribe   body: raw PCM, 16 kHz s16le mono
 *                        (Content-Type: application/octet-stream)    -> TranscribeResponse
 * GET  /api/events       text/event-stream of BridgeEvent
 */
export const ROUTES = {
  health: "/api/health",
  envs: "/api/envs",
  threads: "/api/threads",
  thread: (env: string, thread: string) =>
    `/api/envs/${encodeURIComponent(env)}/threads/${encodeURIComponent(thread)}`,
  messages: (env: string, thread: string) => `${ROUTES.thread(env, thread)}/messages`,
  approval: (env: string, thread: string) => `${ROUTES.thread(env, thread)}/approval`,
  answer: (env: string, thread: string) => `${ROUTES.thread(env, thread)}/answer`,
  interrupt: (env: string, thread: string) => `${ROUTES.thread(env, thread)}/interrupt`,
  transcribe: "/api/transcribe",
  events: "/api/events",
} as const;
