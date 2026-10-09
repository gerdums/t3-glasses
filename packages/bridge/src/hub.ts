/**
 * Holds every environment connection and answers the glasses' questions
 * across all of them.
 */
import { EventEmitter } from "node:events";
import type {
  ApprovalDecision,
  EnvSummary,
  SendMode,
  Shelf,
  ThreadDetail,
  ThreadListResponse,
  ThreadSection,
  ThreadSummary,
} from "@t3-glasses/protocol";
import type { EnvironmentConnection } from "./environment.js";
import { activeRunId, countAttention, summarizeThread, threadDetail } from "./model.js";
import { InboxReturnTracker, SECTION_ORDER, buildSections, sectionOf, type ScopedShell, type SectionedThreads } from "./sections.js";

/** Sections shown inline on Home; the others collapse into shelves, as in T3 Code. */
const INLINE_SECTIONS: readonly ThreadSection[] = ["pinned", "active"];

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class Hub extends EventEmitter {
  private readonly connections = new Map<string, EnvironmentConnection>();
  private changeTimer: NodeJS.Timeout | null = null;
  /** One tracker across every environment, like T3's module-scoped tracker. */
  private readonly tracker = new InboxReturnTracker();

  /** Whether T3's "Working section (beta)" is on for this user. */
  constructor(private readonly workingEnabled: () => boolean = () => false) {
    super();
    // Observe on every change so a thread's return to the inbox is stamped when it happens.
    this.on("change", () => this.sectioned());
  }

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
    const sections = this.sectioned();
    return this.list()
      .map((connection) => {
        const mine = this.summaries(sections, connection.id);
        const open = mine.filter((thread) => thread.section !== "settled" && thread.section !== "snoozed");
        return {
          id: connection.id,
          label: connection.label,
          connected: connection.connected,
          ...(connection.error && !connection.connected ? { error: connection.error } : {}),
          attention: countAttention(mine),
          threadCount: open.length,
        };
      })
      .sort((a, b) => Number(b.connected) - Number(a.connected) || a.label.localeCompare(b.label));
  }

  /** Pinned and Active threads inline, then the other sections as shelves. */
  home(envId?: string, limit = 20): ThreadListResponse {
    if (envId) this.require(envId);
    const sections = this.sectioned();
    const workingEnabled = this.workingEnabled();
    const threads = this.summaries(sections, envId, INLINE_SECTIONS).slice(0, limit);
    const shelves: Shelf[] = SECTION_ORDER.filter((section) => !INLINE_SECTIONS.includes(section))
      .filter((section) => section !== "working" || workingEnabled)
      .map((section) => ({ section, count: this.summaries(sections, envId, [section]).length }))
      .filter((shelf) => shelf.count > 0);
    return { threads, shelves, workingEnabled };
  }

  /** One section, or every listed thread in section order. */
  threads(envId?: string, limit = 20, section?: ThreadSection): ThreadSummary[] {
    if (envId) this.require(envId);
    return this.summaries(this.sectioned(), envId, section ? [section] : SECTION_ORDER).slice(0, limit);
  }

  async thread(envId: string, threadId: string): Promise<ThreadDetail> {
    const connection = this.require(envId);
    const projection = await connection.getThreadProjection(threadId);
    const shell = connection.threads.get(threadId);
    const section = shell ? sectionOf(shell, this.workingEnabled()) : undefined;
    return threadDetail(projection, connection, connection.projects, shell, section);
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

  /** Every environment's threads in T3 Code's sections and order. */
  private sectioned(): SectionedThreads {
    const items: ScopedShell[] = this.list().flatMap((connection) =>
      [...connection.threads.values()].map((shell) => ({ environmentId: connection.id, shell })),
    );
    return buildSections(items, { workingEnabled: this.workingEnabled(), tracker: this.tracker });
  }

  private summaries(sections: SectionedThreads, envId?: string, which: readonly ThreadSection[] = SECTION_ORDER): ThreadSummary[] {
    return which.flatMap((section) =>
      sections[section]
        .filter((item) => !envId || item.environmentId === envId)
        .flatMap((item) => {
          const connection = this.connections.get(item.environmentId);
          return connection ? [summarizeThread(item.shell, connection, connection.projects, section)] : [];
        }),
    );
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
