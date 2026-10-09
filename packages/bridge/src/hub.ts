/**
 * Holds every environment connection and answers the glasses' questions
 * across all of them.
 */
import { EventEmitter } from "node:events";
import type {
  ApprovalDecision,
  EnvSummary,
  SendMode,
  ThreadDetail,
  ThreadSummary,
} from "@t3-glasses/protocol";
import type { EnvironmentConnection } from "./environment.js";
import { activeRunId, compareThreads, countAttention, isVisible, summarizeThread, threadDetail } from "./model.js";

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class Hub extends EventEmitter {
  private readonly connections = new Map<string, EnvironmentConnection>();
  private changeTimer: NodeJS.Timeout | null = null;

  list(): EnvironmentConnection[] {
    return [...this.connections.values()];
  }

  has(id: string): boolean {
    return this.connections.has(id);
  }

  add(connection: EnvironmentConnection): void {
    this.connections.get(connection.id)?.stop();
    this.connections.set(connection.id, connection);
    connection.on("change", () => this.scheduleChange());
    connection.start();
    this.scheduleChange();
  }

  remove(id: string): void {
    this.connections.get(id)?.stop();
    this.connections.delete(id);
    this.scheduleChange();
  }

  stop(): void {
    for (const connection of this.connections.values()) connection.stop();
    this.connections.clear();
  }

  envs(): EnvSummary[] {
    return this.list()
      .map((connection) => {
        const threads = this.summaries(connection);
        return {
          id: connection.id,
          label: connection.label,
          connected: connection.connected,
          ...(connection.error && !connection.connected ? { error: connection.error } : {}),
          attention: countAttention(threads),
          threadCount: threads.length,
        };
      })
      .sort((a, b) => Number(b.connected) - Number(a.connected) || a.label.localeCompare(b.label));
  }

  threads(envId?: string, limit = 20): ThreadSummary[] {
    const connections = envId ? [this.require(envId)] : this.list();
    const all = connections.flatMap((connection) => this.summaries(connection));
    return all.sort(compareThreads).slice(0, limit);
  }

  async thread(envId: string, threadId: string): Promise<ThreadDetail> {
    const connection = this.require(envId);
    const projection = await connection.getThreadProjection(threadId);
    return threadDetail(projection, connection, connection.projects, connection.threads.get(threadId));
  }

  async send(envId: string, threadId: string, text: string, mode: SendMode = "auto"): Promise<void> {
    if (!text.trim()) throw new Error("Message is empty");
    await this.require(envId).dispatch({ type: "message.dispatch", threadId, text: text.trim(), mode });
  }

  async approve(envId: string, threadId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    await this.require(envId).dispatch({ type: "runtime-request.respond", threadId, requestId, decision });
  }

  async answer(envId: string, threadId: string, requestId: string, answers: Record<string, string>): Promise<void> {
    await this.require(envId).dispatch({ type: "runtime-request.respond", threadId, requestId, answers });
  }

  async interrupt(envId: string, threadId: string): Promise<boolean> {
    const connection = this.require(envId);
    const runId = activeRunId(await connection.getThreadProjection(threadId));
    if (!runId) return false;
    await connection.dispatch({ type: "run.interrupt", threadId, runId });
    return true;
  }

  private summaries(connection: EnvironmentConnection): ThreadSummary[] {
    return [...connection.threads.values()]
      .filter(isVisible)
      .map((thread) => summarizeThread(thread, connection, connection.projects));
  }

  private require(envId: string): EnvironmentConnection {
    const connection = this.connections.get(envId);
    if (!connection) throw new NotFoundError(`Unknown environment ${envId}`);
    return connection;
  }

  private scheduleChange(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.emit("change");
    }, 400);
    this.changeTimer.unref?.();
  }
}
