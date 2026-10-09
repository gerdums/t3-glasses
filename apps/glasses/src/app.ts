import {
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerUpgrade,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import type { ThreadSummary } from '@t3-glasses/protocol';
import type { BridgeApi } from './api';
import {
  TRANSCRIPT_ITEMS,
  actionItems,
  computerThreadsPage,
  computersPage,
  homePage,
  listRows,
  sectionPage,
  messagePage,
  threadPage,
  type Action,
  type ActionItem,
  type Card,
  type Page,
} from './render';
import { initialState, transition, type Intent, type State } from './screens';
import { VoiceCapture } from './voice';

const POLL_MS = 3000;
const NOTICE_MS = 1600;

// Protobuf omits zero values, so a click (CLICK_EVENT = 0) arrives with no eventType at all.
const eventType = (event: EvenHubEvent) => {
  const source = event.listEvent ?? event.textEvent ?? (event.sysEvent && !event.sysEvent.imuData ? event.sysEvent : undefined);
  return source ? OsEventTypeList.fromJson(source.eventType ?? 0) : undefined;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function itemsOf(card: Card | undefined): ActionItem[] {
  if (card?.kind === 'actions') return card.items;
  if (card?.kind === 'transcript') return TRANSCRIPT_ITEMS;
  return [];
}

let pageCreated = false;

/** Creates the startup page once per launch, rebuilding if one already exists. */
async function showPage(bridge: EvenAppBridge, next: Page): Promise<void> {
  if (pageCreated) {
    if (!(await bridge.rebuildPageContainer(next))) throw new Error('Glasses page rebuild failed');
    return;
  }
  const result = await bridge.createStartUpPageContainer(next);
  // `invalid` also means a page already exists, e.g. after the WebView reloads.
  if (result === StartUpPageCreateResult.invalid) {
    if (!(await bridge.rebuildPageContainer(next))) throw new Error('Glasses page rebuild failed');
  } else if (result !== StartUpPageCreateResult.success) {
    throw new Error(`Glasses page failed: ${result}`);
  }
  pageCreated = true;
}

/** Shown on the glasses until the phone page has paired with a bridge. */
export async function showSetupScreen(bridge: EvenAppBridge): Promise<void> {
  await showPage(
    bridge,
    messagePage(
      'T3 Code',
      'Open T3 Glasses in the Even app on your phone and enter the pairing code.\n\nGet a code on your computer with: t3-glasses glasses-code',
      '\u00b7 Not paired',
    ),
  );
}

export class GlassesApp {
  state: State = initialState();
  private readonly voice: VoiceCapture;
  private lastPage?: Page;
  private timer?: ReturnType<typeof setInterval>;
  private noticeTimer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(
    private readonly bridge: EvenAppBridge,
    private readonly api: BridgeApi,
  ) {
    this.voice = new VoiceCapture(bridge, api);
  }

  private dispatch(intent: Intent) {
    this.state = transition(this.state, intent);
  }

  async start() {
    this.unsubscribe = this.bridge.onEvenHubEvent((event) => {
      this.queue = this.queue.then(() => this.handle(event)).catch((error) => this.showError(error));
    });
    await this.display();
    this.timer = setInterval(() => {
      if (this.state.foreground) void this.refresh();
    }, POLL_MS);
    await this.refresh();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.unsubscribe?.();
    await this.voice.cancel();
  }

  // ---- Rendering --------------------------------------------------------------

  private render(): Page {
    const s = this.state;
    if (s.screen === 'Thread' && s.detail) {
      return threadPage(s.detail, { page: s.page, card: s.card, items: actionItems(s.detail) });
    }
    if (s.screen === 'Threads') {
      const env = s.envs.find((e) => e.id === s.envFilter);
      return computerThreadsPage(s.computer, env?.label ?? 'Threads');
    }
    if (s.screen === 'Section' && s.section) {
      return sectionPage(s.sectionThreads, s.section, !(s.sectionFrom === 'Threads' && s.envFilter));
    }
    if (s.screen === 'Computers') return computersPage(s.envs, s.connection);
    return homePage(s.home, s.envs, s.connection);
  }

  private async display() {
    const next = this.render();
    if (!this.lastPage) {
      await showPage(this.bridge, next);
      this.lastPage = next;
      return;
    }
    const previous = this.lastPage;
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
    const layout = (p: Page) => JSON.stringify({ ...p, textObject: p.textObject?.map(({ content: _content, ...rest }) => rest) });
    if (previous && layout(previous) === layout(next)) {
      // Same layout: update only the text that changed, without flicker.
      for (const [index, current] of (next.textObject ?? []).entries()) {
        if (current.content === previous.textObject?.[index]?.content) continue;
        const ok = await this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: current.containerID, containerName: current.containerName, content: current.content }),
        );
        if (!ok) throw new Error('Glasses text update failed');
      }
    } else if (!(await this.bridge.rebuildPageContainer(next))) {
      throw new Error('Glasses page rebuild failed');
    }
    this.lastPage = next;
  }

  /** Reflects a handled request right away instead of waiting for the next poll. */
  private resolvePending() {
    const detail = this.state.detail;
    if (!detail?.pending) return;
    this.dispatch({ type: 'DETAIL', detail: { ...detail, pending: undefined, attention: 'running', activity: undefined } });
  }

  private async notice(text: string) {
    if (this.state.screen !== 'Thread') {
      this.dispatch({ type: 'CONNECTION', text });
      await this.display();
      return;
    }
    this.dispatch({ type: 'SHOW_CARD', card: { kind: 'notice', text } });
    await this.display();
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = undefined;
      if (this.state.card?.kind !== 'notice') return;
      this.dispatch({ type: 'CLOSE_CARD' });
      void this.display().then(() => this.refresh());
    }, NOTICE_MS);
  }

  private async showError(error: unknown) {
    try {
      await this.notice(`× ${messageOf(error)}`);
    } catch {
      // The glasses bridge itself failed; nothing more to show.
    }
  }

  // ---- Data -------------------------------------------------------------------

  async refresh() {
    if (!this.state.foreground) return;
    const generation = ++this.generation;
    const screen = this.state.screen;
    const stale = () => generation !== this.generation || this.state.screen !== screen;
    try {
      if (screen === 'Home' || screen === 'Computers') {
        const [envs, home] = await Promise.all([this.api.envs(), screen === 'Home' ? this.api.home(undefined, 20) : undefined]);
        if (stale()) return;
        const online = envs.filter((env) => env.connected).length;
        this.dispatch({ type: 'ENVS', envs });
        if (home) this.dispatch({ type: 'HOME', home });
        this.dispatch({ type: 'CONNECTION', text: `\u2022 Connected \u00b7 ${online} of ${envs.length} online` });
      } else if (screen === 'Threads') {
        const computer = await this.api.home(this.state.envFilter, 20);
        if (stale()) return;
        this.dispatch({ type: 'COMPUTER', computer });
      } else if (screen === 'Section' && this.state.section) {
        const env = this.state.sectionFrom === 'Threads' ? this.state.envFilter : undefined;
        const threads = await this.api.threads(env, 20, this.state.section);
        if (stale()) return;
        this.dispatch({ type: 'SECTION_THREADS', threads });
      } else if (this.state.detail) {
        const { envId, id } = this.state.detail;
        const detail = await this.api.thread(envId, id);
        if (stale() || this.state.detail?.id !== id) return;
        this.dispatch({ type: 'DETAIL', detail });
        // Keep an open actions card in step with the request it answers.
        if (this.state.card?.kind === 'actions') this.dispatch({ type: 'SHOW_CARD', card: { kind: 'actions', items: actionItems(detail) } });
      }
      // Voice and notice cards own the screen until they finish.
      if (this.state.card && this.state.card.kind !== 'actions') return;
      await this.display();
    } catch (error) {
      if (stale()) return;
      this.dispatch({ type: 'CONNECTION', text: `× ${messageOf(error)}` });
      if (screen === 'Home' || screen === 'Computers') await this.display();
    }
  }

  private async openThread(summary: ThreadSummary | undefined) {
    if (!summary) return;
    const detail = await this.api.thread(summary.envId, summary.id);
    this.dispatch({ type: 'OPEN_THREAD', detail });
    await this.display();
  }

  // ---- Voice ------------------------------------------------------------------

  private async beginVoice(target: 'reply' | 'answer') {
    this.dispatch({ type: 'VOICE_TARGET', target });
    this.dispatch({ type: 'SHOW_CARD', card: { kind: 'listening' } });
    await this.display();
    await this.voice.start();
  }

  private async finishVoice() {
    this.dispatch({ type: 'SHOW_CARD', card: { kind: 'transcribing' } });
    await this.display();
    const text = await this.voice.stop();
    if (!text) throw new Error('No speech recognized');
    this.dispatch({ type: 'SHOW_CARD', card: { kind: 'transcript', text } });
    await this.display();
  }

  private async sendTranscript() {
    const detail = this.state.detail;
    const card = this.state.card;
    if (!detail || card?.kind !== 'transcript') return;
    if (this.state.voiceTarget === 'answer') {
      const pending = detail.pending;
      if (pending?.kind !== 'question' || !pending.questions[0]) throw new Error('Question no longer pending');
      await this.api.answer(detail.envId, detail.id, { requestId: pending.requestId, answers: { [pending.questions[0].id]: card.text } });
      this.resolvePending();
    } else {
      await this.api.send(detail.envId, detail.id, { text: card.text });
    }
    await this.notice('• Sent');
  }

  // ---- Actions ----------------------------------------------------------------

  private async perform(action: Action) {
    const detail = this.state.detail;
    if (!detail) return;
    const { envId, id } = detail;
    switch (action.kind) {
      case 'back':
        this.dispatch({ type: 'CLOSE_CARD' });
        await this.display();
        return;
      case 'refresh':
        this.dispatch({ type: 'CLOSE_CARD' });
        await this.refresh();
        return;
      case 'reply':
      case 'dictateAnswer':
        await this.beginVoice(action.kind === 'reply' ? 'reply' : 'answer');
        return;
      case 'send':
        await this.sendTranscript();
        return;
      case 'cancelVoice':
        this.dispatch({ type: 'CLOSE_CARD' });
        await this.display();
        return;
      case 'approval': {
        if (detail.pending?.kind !== 'approval') throw new Error('Request already handled');
        await this.api.approval(envId, id, { requestId: detail.pending.requestId, decision: action.decision });
        this.resolvePending();
        const verb = action.decision === 'decline' ? 'Denied' : action.decision === 'cancel' ? 'Canceled' : 'Approved';
        await this.notice(`• ${verb}`);
        return;
      }
      case 'answer':
        if (detail.pending?.kind !== 'question') throw new Error('Question already answered');
        await this.api.answer(envId, id, { requestId: detail.pending.requestId, answers: { [action.questionId]: action.label } });
        this.resolvePending();
        await this.notice('• Answered');
        return;
      case 'interrupt':
        await this.api.interrupt(envId, id);
        await this.notice('• Interrupt sent');
        return;
    }
  }

  // ---- Input ------------------------------------------------------------------

  async handle(event: EvenHubEvent) {
    if (event.audioEvent) {
      this.voice.add(event.audioEvent.audioPcm);
      return;
    }
    const s = this.state;
    const type = eventType(event);

    if (type === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      this.dispatch({ type: 'FOREGROUND', foreground: false });
      this.generation += 1;
      if (s.card?.kind === 'listening') {
        await this.voice.cancel();
        this.dispatch({ type: 'CLOSE_CARD' });
      }
      return;
    }
    if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      this.dispatch({ type: 'FOREGROUND', foreground: true });
      await this.refresh();
      return;
    }

    // Native context menu (registered on the thread page).
    if (event.menuItemClickEvent && s.detail) {
      const item = actionItems(s.detail)[(event.menuItemClickEvent.itemID ?? 0) - 1];
      if (item) await this.perform(item.action);
      return;
    }

    if (type === OsEventTypeList.LONG_PRESS_EVENT && s.screen === 'Thread' && !s.card) {
      await this.beginVoice(s.detail?.pending?.kind === 'question' ? 'answer' : 'reply');
      return;
    }
    if (type === OsEventTypeList.LONG_PRESS_RELEASE_EVENT && s.card?.kind === 'listening') {
      await this.finishVoice();
      return;
    }

    if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      if (s.card?.kind === 'listening') await this.voice.cancel();
      if (s.screen === 'Home' && !s.card) return;
      this.dispatch({ type: 'BACK' });
      await this.display();
      void this.refresh();
      return;
    }

    // Swiping past either end of the conversation pages through history.
    if ((type === OsEventTypeList.SCROLL_TOP_EVENT || type === OsEventTypeList.SCROLL_BOTTOM_EVENT) && s.screen === 'Thread' && !s.card) {
      this.dispatch({ type: 'PAGE', delta: type === OsEventTypeList.SCROLL_TOP_EVENT ? 1 : -1 });
      await this.display();
      return;
    }

    if (type !== OsEventTypeList.CLICK_EVENT) return;
    const index = event.listEvent?.currentSelectItemIndex ?? 0;

    if (s.screen === 'Home' || s.screen === 'Threads') {
      const row = listRows(s.screen === 'Home' ? s.home : s.computer, s.screen === 'Home')[index];
      if (!row) return;
      if (row.kind === 'thread') {
        await this.openThread(row.thread);
      } else {
        this.dispatch(row.kind === 'shelf' ? { type: 'OPEN_SECTION', section: row.section } : { type: 'OPEN_COMPUTERS' });
        await this.display();
        await this.refresh();
      }
      return;
    }
    if (s.screen === 'Computers') {
      const env = s.envs[index];
      if (!env) return;
      this.dispatch({ type: 'OPEN_THREADS', env: env.id });
      await this.display();
      await this.refresh();
      return;
    }
    if (s.screen === 'Section') {
      await this.openThread(s.sectionThreads[index]);
      return;
    }
    // Thread screen.
    const card = s.card;
    if (!card && s.detail) {
      this.dispatch({ type: 'SHOW_CARD', card: { kind: 'actions', items: actionItems(s.detail) } });
      await this.display();
      return;
    }
    if (card?.kind === 'listening') {
      await this.finishVoice();
      return;
    }
    if (card?.kind === 'notice') {
      this.dispatch({ type: 'CLOSE_CARD' });
      await this.display();
      return;
    }
    const item = itemsOf(card)[index];
    if (item) await this.perform(item.action);
  }
}
