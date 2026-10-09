import { ROUTES, type AnswerRequest, type ApprovalRequest, type BridgeEvent, type EnvSummary, type HealthResponse, type OkResponse, type SendMessageRequest, type ThreadDetail, type ThreadSummary, type TranscribeResponse } from '@t3-glasses/protocol';

export interface BridgeApi {
  health(): Promise<HealthResponse>;
  envs(): Promise<EnvSummary[]>;
  threads(env?: string, limit?: number): Promise<ThreadSummary[]>;
  thread(env: string, thread: string): Promise<ThreadDetail>;
  send(env: string, thread: string, body: SendMessageRequest): Promise<OkResponse>;
  approval(env: string, thread: string, body: ApprovalRequest): Promise<OkResponse>;
  answer(env: string, thread: string, body: AnswerRequest): Promise<OkResponse>;
  interrupt(env: string, thread: string): Promise<OkResponse>;
  transcribe(pcm: Uint8Array): Promise<TranscribeResponse>;
  events(onEvent: (event: BridgeEvent) => void): () => void;
}

export class HttpBridgeApi implements BridgeApi {
  constructor(readonly baseUrl: string, readonly token: string, readonly timeoutMs = 8000) {}
  private async request<T>(path: string, method = 'GET', body?: object | Uint8Array): Promise<T> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const raw = body instanceof Uint8Array;
      const response = await fetch(new URL(path, this.baseUrl), {
        method, signal: abort.signal,
        headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' } : {}) },
        body: body ? (raw ? new Uint8Array(body).buffer : JSON.stringify(body)) : undefined,
      });
      let data: unknown;
      try { data = await response.json(); } catch { throw new Error(`Bridge returned invalid JSON (${response.status})`); }
      if (!response.ok || (typeof data === 'object' && data !== null && 'ok' in data && data.ok === false)) {
        const message = typeof data === 'object' && data !== null && 'error' in data ? String(data.error) : `HTTP ${response.status}`;
        throw new Error(`Bridge: ${message}`);
      }
      return data as T;
    } catch (error) {
      if (abort.signal.aborted) throw new Error('Bridge request timed out');
      if (error instanceof TypeError) throw new Error(`Cannot reach bridge: ${error.message}`);
      throw error;
    } finally { clearTimeout(timer); }
  }
  health() { return this.request<HealthResponse>(ROUTES.health); }
  async envs() { return (await this.request<{envs: EnvSummary[]}>(ROUTES.envs)).envs; }
  async threads(env?: string, limit = 20) { const query = new URLSearchParams({ limit: String(limit) }); if (env) query.set('env', env); return (await this.request<{threads: ThreadSummary[]}>(`${ROUTES.threads}?${query}`)).threads; }
  thread(env: string, thread: string) { return this.request<ThreadDetail>(ROUTES.thread(env, thread)); }
  send(env: string, thread: string, body: SendMessageRequest) { return this.request<OkResponse>(ROUTES.messages(env, thread), 'POST', body); }
  approval(env: string, thread: string, body: ApprovalRequest) { return this.request<OkResponse>(ROUTES.approval(env, thread), 'POST', body); }
  answer(env: string, thread: string, body: AnswerRequest) { return this.request<OkResponse>(ROUTES.answer(env, thread), 'POST', body); }
  interrupt(env: string, thread: string) { return this.request<OkResponse>(ROUTES.interrupt(env, thread), 'POST'); }
  transcribe(pcm: Uint8Array) { return this.request<TranscribeResponse>(ROUTES.transcribe, 'POST', pcm); }
  events(onEvent: (event: BridgeEvent) => void): () => void {
    const url = new URL(ROUTES.events, this.baseUrl);
    url.searchParams.set('token', this.token);
    const source = new EventSource(url);
    for (const type of ['envs', 'thread'] as const) source.addEventListener(type, (raw) => { try { onEvent(JSON.parse((raw as MessageEvent).data) as BridgeEvent); } catch { /* malformed event */ } });
    return () => source.close();
  }
}
