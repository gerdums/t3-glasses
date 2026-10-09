import { OsEventTypeList, StartUpPageCreateResult, type EvenAppBridge, type EvenHubEvent, TextContainerUpgrade } from '@evenrealities/even_hub_sdk';
import type { BridgeApi } from './api';
import { actionItems, actionsPage, homePage, messagePage, threadPage, threadText, threadsPage, type Action, type Page } from './render';
import { initialState, transition, type Intent, type State } from './screens';
import { VoiceCapture } from './voice';

// Protobuf omits zero values, so a click (CLICK_EVENT = 0) arrives with no eventType at all.
const eventType = (event: EvenHubEvent) => {
  const source = event.listEvent ?? event.textEvent ?? (event.sysEvent && !event.sysEvent.imuData ? event.sysEvent : undefined);
  return source ? OsEventTypeList.fromJson(source.eventType ?? 0) : undefined;
};
export class GlassesApp {
  state: State = initialState();
  private voice: VoiceCapture;
  /** The SDK allows one startup page per app launch; later apps must rebuild. */
  private static pageCreated = false;
  private lastPage?: Page;
  private timer?: ReturnType<typeof setInterval>;
  private confirmTimer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  constructor(private bridge: EvenAppBridge, private api: BridgeApi) { this.voice = new VoiceCapture(bridge, api); }
  private dispatch(intent: Intent) { this.state = transition(this.state, intent); }
  async start() {
    this.unsubscribe = this.bridge.onEvenHubEvent(event => { this.queue = this.queue.then(() => this.handle(event)).catch(error => this.showError(error)); });
    await this.display();
    this.timer = setInterval(() => { if (this.state.foreground) void this.refresh(); }, 3000);
    await this.refresh();
  }
  async stop() { if (this.timer) clearInterval(this.timer); if (this.confirmTimer) clearTimeout(this.confirmTimer); this.unsubscribe?.(); await this.voice.cancel(); }
  private async display() {
    const s = this.state;
    const page = s.screen === 'Home' ? homePage(s.envs, s.envs.reduce((n, e) => n + e.attention.approval + e.attention.question + e.attention.failed, 0), s.connection)
      : s.screen === 'Threads' ? threadsPage(s.threads, s.envFilter ? (s.envs.find(e => e.id === s.envFilter)?.label || s.envFilter) : 'Inbox')
      : s.screen === 'Thread' && s.detail ? threadPage(s.detail, s.actions)
      : s.screen === 'Actions' ? actionsPage(s.actions)
      : s.screen === 'Voice' ? messagePage(s.recording ? 'Listening... release to stop' : s.transcript ? `${s.transcript}\n\nClick: send  Double: cancel` : 'Transcribing...')
      : messagePage(s.confirm);
    if (!GlassesApp.pageCreated) {
      const result = await this.bridge.createStartUpPageContainer(page);
      // `invalid` also means a page already exists, e.g. after the WebView reloads: rebuild it instead.
      if (result === StartUpPageCreateResult.invalid) {
        if (!await this.bridge.rebuildPageContainer(page)) throw new Error('Glasses page rebuild failed');
      } else if (result !== StartUpPageCreateResult.success) throw new Error(`Glasses page failed: ${result}`);
      GlassesApp.pageCreated = true;
    } else {
      const old = this.lastPage;
      if (old && JSON.stringify(old) === JSON.stringify(page)) return;
      const withoutText = (p: Page) => JSON.stringify({ ...p, textObject: p.textObject?.map(({ content: _content, ...rest }) => rest) });
      if (old && withoutText(old) === withoutText(page)) {
        for (const [index, current] of (page.textObject || []).entries()) {
          if (current.content !== old.textObject?.[index]?.content) {
            if (!await this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: current.containerID, containerName: current.containerName, content: current.content }))) throw new Error('Glasses text update failed');
          }
        }
      } else if (!await this.bridge.rebuildPageContainer(page)) throw new Error('Glasses page rebuild failed');
    }
    this.lastPage = page;
  }
  private async showError(error: unknown) { const message = error instanceof Error ? error.message : String(error); this.dispatch({ type: 'CONFIRM', text: message }); try { await this.display(); } catch { /* bridge already failed */ } this.returnFromConfirm(); }
  private returnFromConfirm() { if (this.confirmTimer) clearTimeout(this.confirmTimer); this.confirmTimer = setTimeout(() => { this.confirmTimer = undefined; this.dispatch({ type: 'BACK' }); void this.display(); }, 1800); }
  async refresh() {
    if (!this.state.foreground) return;
    const generation = ++this.generation;
    const screen = this.state.screen;
    try {
      if (screen === 'Home') {
        const [envs] = await Promise.all([this.api.envs(), this.api.health()]);
        if (generation !== this.generation || this.state.screen !== 'Home') return;
        this.dispatch({ type: 'ENVS', envs }); this.dispatch({ type: 'CONNECTION', text: 'Bridge connected' }); await this.display();
      } else if (screen === 'Threads') {
        const threads = await this.api.threads(this.state.envFilter, 20);
        if (generation !== this.generation || this.state.screen !== 'Threads') return;
        this.dispatch({ type: 'THREADS', threads }); await this.display();
      } else if (['Thread', 'Actions'].includes(screen) && this.state.detail) {
        const old = this.state.detail;
        const detail = await this.api.thread(old.envId, old.id);
        if (generation !== this.generation || this.state.detail?.id !== old.id || !['Thread', 'Actions'].includes(this.state.screen)) return;
        const newActions = actionItems(detail);
        const sameLayout = this.state.screen === 'Thread' && JSON.stringify(this.state.actions) === JSON.stringify(newActions) && detail.status === old.status && detail.envLabel === old.envLabel;
        this.dispatch({ type: 'DETAIL', detail }); this.dispatch({ type: 'ACTIONS', actions: newActions });
        if (sameLayout) {
          if (threadText(detail) !== threadText(old) && !await this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'thread', content: threadText(detail) }))) throw new Error('Glasses text update failed');
          this.lastPage = threadPage(detail, newActions);
        } else await this.display();
      }
    } catch (error) { this.dispatch({ type: 'CONNECTION', text: error instanceof Error ? error.message : String(error) }); if (screen === 'Home') await this.display(); }
  }
  private async openThread(index: number) {
    const summary = this.state.threads[index]; if (!summary) return;
    const detail = await this.api.thread(summary.envId, summary.id);
    this.dispatch({ type: 'OPEN_THREAD', detail }); this.dispatch({ type: 'ACTIONS', actions: actionItems(detail) }); await this.display();
  }
  private async beginVoice(target: 'reply' | 'answer') {
    this.dispatch({ type: 'VOICE_TARGET', target }); this.dispatch({ type: 'START_VOICE' }); await this.display();
    await this.voice.start();
  }
  private async finishVoice() {
    this.dispatch({ type: 'STOP_VOICE' }); await this.display();
    const text = await this.voice.stop();
    if (!text) throw new Error('No speech recognized');
    this.dispatch({ type: 'TRANSCRIPT', text }); await this.display();
  }
  private async perform(action: Action) {
    const detail = this.state.detail;
    if (!detail) return;
    const env = detail.envId, id = detail.id;
    if (action.kind === 'back') { this.dispatch({ type: 'BACK' }); await this.display(); return; }
    if (action.kind === 'refresh') { this.dispatch({ type: 'BACK' }); await this.display(); await this.refresh(); return; }
    if (action.kind === 'showRequest') { this.dispatch({ type: 'CONFIRM', text: detail.pending?.kind === 'approval' ? detail.pending.prompt : 'No request' }); await this.display(); return; }
    if (action.kind === 'reply' || action.kind === 'dictateAnswer') { await this.beginVoice(action.kind === 'reply' ? 'reply' : 'answer'); return; }
    if (action.kind === 'approval' && detail.pending?.kind === 'approval') await this.api.approval(env, id, { requestId: detail.pending.requestId, decision: action.decision });
    else if (action.kind === 'answer' && detail.pending?.kind === 'question') await this.api.answer(env, id, { requestId: detail.pending.requestId, answers: { [action.questionId]: action.label } });
    else if (action.kind === 'interrupt') await this.api.interrupt(env, id);
    else throw new Error('Request changed; refresh the thread');
    this.dispatch({ type: 'CONFIRM', text: action.kind === 'approval' ? (action.decision === 'decline' ? 'Denied' : action.decision === 'cancel' ? 'Canceled' : 'Approved') : 'Sent' }); await this.display(); this.returnFromConfirm();
  }
  private async sendVoice() {
    const d = this.state.detail; if (!d || !this.state.transcript) return;
    if (this.state.voiceTarget === 'answer') {
      if (d.pending?.kind !== 'question' || !d.pending.questions[0]) throw new Error('Question no longer pending');
      await this.api.answer(d.envId, d.id, { requestId: d.pending.requestId, answers: { [d.pending.questions[0].id]: this.state.transcript } });
    } else await this.api.send(d.envId, d.id, { text: this.state.transcript });
    this.dispatch({ type: 'CONFIRM', text: 'Sent' }); await this.display(); this.returnFromConfirm();
  }
  async handle(event: EvenHubEvent) {
    if (event.audioEvent) { this.voice.add(event.audioEvent.audioPcm); return; }
    const type = eventType(event);
    if (type === OsEventTypeList.FOREGROUND_EXIT_EVENT) { this.dispatch({ type: 'FOREGROUND_EXIT' }); this.generation++; if (this.state.recording) { await this.voice.cancel(); this.dispatch({ type: 'STOP_VOICE' }); this.dispatch({ type: 'BACK' }); } return; }
    if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) { this.dispatch({ type: 'FOREGROUND_ENTER' }); await this.refresh(); return; }
    if (event.menuItemClickEvent && this.state.detail) { const item = this.state.actions[(event.menuItemClickEvent.itemID ?? 0) - 1]; if (item) await this.perform(item.action); return; }
    if (type === OsEventTypeList.SCROLL_TOP_EVENT || type === OsEventTypeList.SCROLL_BOTTOM_EVENT) { if (event.listEvent?.currentSelectItemIndex != null) this.dispatch({ type: 'SELECT', index: event.listEvent.currentSelectItemIndex }); return; }
    if (type === OsEventTypeList.LONG_PRESS_EVENT && this.state.screen === 'Thread') { await this.beginVoice('reply'); return; }
    if (type === OsEventTypeList.LONG_PRESS_RELEASE_EVENT && this.state.screen === 'Voice' && this.state.recording) { await this.finishVoice(); return; }
    if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) { if (this.state.screen === 'Voice') await this.voice.cancel(); if (this.confirmTimer) clearTimeout(this.confirmTimer); this.dispatch({ type: 'BACK' }); await this.display(); return; }
    if (type !== OsEventTypeList.CLICK_EVENT) return;
    const s = this.state;
    const index = event.listEvent?.currentSelectItemIndex ?? s.selected;
    if (s.screen === 'Home') { this.dispatch({ type: 'OPEN_THREADS', env: index === 0 ? undefined : s.envs[index - 1]?.id }); await this.display(); await this.refresh(); }
    else if (s.screen === 'Threads') await this.openThread(index);
    else if (s.screen === 'Thread') { this.dispatch({ type: 'OPEN_ACTIONS' }); await this.display(); }
    else if (s.screen === 'Actions') { const item = s.actions[index]; if (item) await this.perform(item.action); }
    else if (s.screen === 'Voice') { if (s.recording) await this.finishVoice(); else await this.sendVoice(); }
    else if (s.screen === 'Confirm' && !this.confirmTimer) { this.dispatch({ type: 'BACK' }); await this.display(); }
  }
}
