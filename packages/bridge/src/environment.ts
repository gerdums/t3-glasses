/**
 * One live connection to a T3 Code environment: keeps its shell (projects and
 * threads) current through `orchestration.subscribeShell`, and runs reads and
 * commands for the glasses.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { RpcClient, type SocketFactory, type StreamHandle } from "./rpc.js";
import type { T3Project, T3ShellStreamItem, T3ThreadProjection, T3ThreadShell } from "./t3types.js";

export const ORCHESTRATION_PROTOCOL = "2";

/** Supplies request headers for an environment; DPoP sessions sign per request. */
export interface EnvironmentAuth {
  headers(method: string, url: string): Promise<Record<string, string>>;
  /** Called after a 401 so the next headers() call re-authenticates. */
  invalidate(): void;
}

export class BearerAuth implements EnvironmentAuth {
  constructor(private readonly token: string) {}
  async headers(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${this.token}` };
  }
  invalidate(): void {}
}

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

export interface EnvironmentTarget {
  id: string;
  label: string;
  httpBaseUrl: string;
}

export type CommandInput =
  | { type: "message.dispatch"; threadId: string; text: string; mode: "auto" | "queue" }
  | { type: "runtime-request.respond"; threadId: string; requestId: string; decision?: string; answers?: Record<string, string> }
  | { type: "run.interrupt"; threadId: string; runId: string };

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class EnvironmentConnection extends EventEmitter {
  readonly projects = new Map<string, T3Project>();
  readonly threads = new Map<string, T3ThreadShell>();
  connected = false;
  error: string | undefined;

  private rpc: RpcClient | null = null;
  private shellStream: StreamHandle | null = null;
  private stopped = false;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private synchronized = false;

  constructor(
    public target: EnvironmentTarget,
    private readonly auth: EnvironmentAuth,
    private readonly socketFactory?: SocketFactory,
  ) {
    super();
  }

  get id(): string {
    return this.target.id;
  }

  get label(): string {
    return this.target.label;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.shellStream?.cancel();
    this.rpc?.close();
    this.rpc = null;
    this.setConnected(false, undefined);
  }

  async fetchJson<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const method = init.method ?? "GET";
    const url = `${this.target.httpBaseUrl}${path}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(url, {
        method,
        headers: {
          ...(await this.auth.headers(method, url)),
          "x-t3-orchestration-protocol": ORCHESTRATION_PROTOCOL,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 401 && attempt === 0) {
        this.auth.invalidate();
        continue;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new HttpStatusError(response.status, `${this.label}: HTTP ${response.status} ${text.slice(0, 200)}`);
      }
      return (await response.json()) as T;
    }
    throw new HttpStatusError(401, `${this.label}: not authorized`);
  }

  async getThreadProjection(threadId: string): Promise<T3ThreadProjection> {
    const rpc = this.requireRpc();
    return rpc.request<T3ThreadProjection>("orchestration.getThreadProjection", { threadId }, 30_000);
  }

  async dispatch(command: CommandInput): Promise<void> {
    const rpc = this.requireRpc();
    const commandId = randomUUID();
    let payload: Record<string, unknown>;
    switch (command.type) {
      case "message.dispatch":
        payload = {
          type: "message.dispatch",
          commandId,
          createdBy: "user",
          creationSource: "mobile",
          threadId: command.threadId,
          messageId: randomUUID(),
          text: command.text,
          attachments: [],
          ...(command.mode === "queue"
            ? { dispatchMode: { type: "queue_after_active" } }
            : { dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" }),
        };
        break;
      case "runtime-request.respond":
        payload = {
          type: "runtime-request.respond",
          commandId,
          threadId: command.threadId,
          requestId: command.requestId,
          ...(command.decision ? { decision: command.decision } : {}),
          ...(command.answers ? { answers: command.answers } : {}),
        };
        break;
      case "run.interrupt":
        payload = {
          type: "run.interrupt",
          commandId,
          threadId: command.threadId,
          runId: command.runId,
          reason: "Interrupted from glasses",
        };
        break;
    }
    await rpc.request("orchestration.dispatchCommand", payload, 30_000);
  }

  private requireRpc(): RpcClient {
    if (!this.rpc?.isOpen) throw new Error(`${this.label} is offline${this.error ? `: ${this.error}` : ""}`);
    return this.rpc;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const { ticket } = await this.fetchJson<{ ticket: string }>("/api/auth/websocket-ticket", { method: "POST" });
      const wsUrl = new URL("/ws", this.target.httpBaseUrl.replace(/^http/, "ws"));
      wsUrl.searchParams.set("orchestrationProtocol", ORCHESTRATION_PROTOCOL);
      wsUrl.searchParams.set("clientSurface", "mobile");
      wsUrl.searchParams.set("wsTicket", ticket);

      const rpc = new RpcClient(this.socketFactory);
      await rpc.connect(wsUrl.toString());
      if (this.stopped) {
        rpc.close();
        return;
      }
      this.rpc = rpc;
      rpc.onClose((reason) => {
        if (this.rpc !== rpc) return;
        this.rpc = null;
        this.setConnected(false, reason);
        this.scheduleReconnect();
      });
      this.synchronized = false;
      this.shellStream = rpc.stream("orchestration.subscribeShell", {}, (item) =>
        this.applyShellItem(item as T3ShellStreamItem),
      );
      this.shellStream.done.catch((error: Error) => {
        if (this.rpc === rpc) {
          this.setConnected(false, error.message);
          rpc.close();
        }
      });
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.setConnected(true, undefined);
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 401) this.auth.invalidate();
      this.setConnected(false, error instanceof Error ? error.message : String(error));
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private setConnected(connected: boolean, error: string | undefined): void {
    const changed = this.connected !== connected || this.error !== error;
    this.connected = connected;
    this.error = error;
    if (changed) this.emit("change", { kind: "connection" });
  }

  /** Exposed for tests. */
  applyShellItem(item: T3ShellStreamItem): void {
    switch (item.kind) {
      case "synchronized":
        this.synchronized = true;
        return;
      case "snapshot": {
        // Enrichment refreshes resend some projects only; the initial snapshot is authoritative.
        const partial = item.resolvedRepositoryIdentityRoots !== undefined;
        if (!partial) {
          this.projects.clear();
          this.threads.clear();
        }
        for (const project of item.snapshot.projects) this.projects.set(project.id, project);
        for (const thread of item.snapshot.threads) this.threads.set(thread.id, thread);
        this.emit("change", { kind: "snapshot" });
        return;
      }
      case "project.updated":
        this.projects.set(item.project.id, item.project);
        this.emit("change", { kind: "project" });
        return;
      case "project.removed":
        this.projects.delete(item.projectId);
        this.emit("change", { kind: "project" });
        return;
      case "thread.updated":
        if (item.location === "active") this.threads.set(item.thread.id, item.thread);
        else this.threads.delete(item.thread.id);
        this.emit("change", { kind: "thread", threadId: item.thread.id });
        return;
      case "thread.removed":
        this.threads.delete(item.threadId);
        this.emit("change", { kind: "thread", threadId: item.threadId });
        return;
    }
  }
}
