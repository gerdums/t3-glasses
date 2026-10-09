/**
 * Minimal client for T3 Code's WebSocket RPC (Effect RPC, JSON serialization).
 *
 * Frames:
 *   -> {"_tag":"Request","id":"1","tag":"<method>","payload":{...},"headers":[]}
 *   <- {"_tag":"Chunk","requestId":"1","values":[...]}   (streams; reply with Ack)
 *   <- {"_tag":"Exit","requestId":"1","exit":{"_tag":"Success","value":...}}
 *   <- {"_tag":"Exit","requestId":"1","exit":{"_tag":"Failure","cause":[...]}}
 *   <> {"_tag":"Ping"} / {"_tag":"Pong"}
 */

type Frame = { _tag: string; [key: string]: unknown };

export class RpcError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

interface Pending {
  onChunk?: (values: unknown[]) => void;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export interface StreamHandle {
  done: Promise<void>;
  cancel(): void;
}

/** The subset of the WHATWG WebSocket the client needs; lets tests inject a socket. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

const OPEN = 1;
const PING_INTERVAL_MS = 20_000;
const IDLE_TIMEOUT_MS = 65_000;

export function describeCause(cause: unknown): string {
  const parts = Array.isArray(cause) ? cause : [cause];
  const messages = parts.map((part) => {
    if (part && typeof part === "object") {
      const record = part as Record<string, unknown>;
      const inner = (record.error ?? record.defect) as Record<string, unknown> | string | undefined;
      if (typeof inner === "string") return inner;
      if (inner && typeof inner === "object") {
        const message = inner.message ?? inner.reason ?? inner.code;
        const tag = inner._tag;
        if (message && tag) return `${String(tag)}: ${String(message)}`;
        if (message) return String(message);
        return JSON.stringify(inner).slice(0, 300);
      }
      if (record._tag === "Interrupt") return "interrupted";
    }
    return JSON.stringify(part)?.slice(0, 300) ?? "unknown error";
  });
  return messages.join("; ");
}

export class RpcClient {
  private socket: SocketLike | null = null;
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private pingTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;
  private closedListeners = new Set<(reason: string) => void>();

  constructor(private readonly socketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike) {}

  get isOpen(): boolean {
    return this.socket?.readyState === OPEN;
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  connect(url: string, timeoutMs = 15_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.socketFactory(url);
      this.socket = socket;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new RpcError("Timed out opening the T3 WebSocket"));
      }, timeoutMs);

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.lastMessageAt = Date.now();
        this.startPing();
        resolve();
      };
      socket.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new RpcError("Could not open the T3 WebSocket"));
      };
      socket.onclose = (event) => {
        clearTimeout(timer);
        const reason = `socket closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`;
        if (!settled) {
          settled = true;
          reject(new RpcError(reason));
        }
        this.teardown(reason);
      };
      socket.onmessage = (event) => this.handleMessage(event.data);
    });
  }

  close(): void {
    this.socket?.close(1000, "client closing");
    this.teardown("client closed");
  }

  request<T>(tag: string, payload: unknown, timeoutMs = 30_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.send(tag, payload, reject);
      if (id === null) return;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.sendFrame({ _tag: "Interrupt", requestId: id, interruptors: [] });
        reject(new RpcError(`${tag} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    });
  }

  stream(tag: string, payload: unknown, onValue: (value: unknown) => void): StreamHandle {
    let id: string | null = null;
    const done = new Promise<void>((resolve, reject) => {
      id = this.send(tag, payload, reject);
      if (id === null) return;
      this.pending.set(id, {
        onChunk: (values) => values.forEach(onValue),
        resolve: () => resolve(),
        reject,
      });
    });
    return {
      done,
      cancel: () => {
        if (id === null) return;
        const entry = this.pending.get(id);
        this.pending.delete(id);
        this.sendFrame({ _tag: "Interrupt", requestId: id, interruptors: [] });
        entry?.resolve(undefined);
      },
    };
  }

  private send(tag: string, payload: unknown, reject: (error: Error) => void): string | null {
    if (!this.isOpen) {
      reject(new RpcError("T3 WebSocket is not connected"));
      return null;
    }
    const id = String(this.nextId++);
    this.sendFrame({ _tag: "Request", id, tag, payload, headers: [] });
    return id;
  }

  private sendFrame(frame: Frame): void {
    if (this.isOpen) this.socket!.send(JSON.stringify(frame));
  }

  private handleMessage(data: unknown): void {
    this.lastMessageAt = Date.now();
    const text = typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const frames = (Array.isArray(parsed) ? parsed : [parsed]) as Frame[];
    for (const frame of frames) this.handleFrame(frame);
  }

  private handleFrame(frame: Frame): void {
    switch (frame._tag) {
      case "Ping":
        this.sendFrame({ _tag: "Pong" });
        return;
      case "Pong":
        return;
      case "Chunk": {
        const requestId = String(frame.requestId);
        const entry = this.pending.get(requestId);
        if (!entry) return;
        this.sendFrame({ _tag: "Ack", requestId });
        entry.onChunk?.(frame.values as unknown[]);
        return;
      }
      case "Exit": {
        const requestId = String(frame.requestId);
        const entry = this.pending.get(requestId);
        if (!entry) return;
        this.pending.delete(requestId);
        if (entry.timer) clearTimeout(entry.timer);
        const exit = frame.exit as { _tag: string; value?: unknown; cause?: unknown };
        if (exit?._tag === "Success") entry.resolve(exit.value);
        else entry.reject(new RpcError(describeCause(exit?.cause), exit?.cause));
        return;
      }
      case "Defect": {
        const error = new RpcError(`T3 server defect: ${describeCause(frame.defect)}`);
        for (const entry of this.pending.values()) entry.reject(error);
        this.pending.clear();
        return;
      }
      default:
        return;
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > IDLE_TIMEOUT_MS) {
        this.socket?.close(4000, "idle timeout");
        this.teardown("idle timeout");
        return;
      }
      this.sendFrame({ _tag: "Ping" });
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private teardown(reason: string): void {
    if (!this.socket) return;
    this.socket = null;
    this.stopPing();
    const error = new RpcError(reason);
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    for (const listener of this.closedListeners) listener(reason);
  }
}
