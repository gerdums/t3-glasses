import { describe, expect, it, vi } from 'vitest';
import { List_ItemEvent, OsEventTypeList, StartUpPageCreateResult, Sys_ItemEvent, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import type { ThreadDetail } from '@t3-glasses/protocol';
import type { BridgeApi } from './api';
import { GlassesApp } from './app';
import { initialState, transition } from './screens';

const detail: ThreadDetail = {
  envId: 'm4',
  envLabel: 'M4',
  id: 'one',
  title: 'Task',
  projectTitle: 'T3',
  status: 'running',
  attention: 'approval',
  updatedAt: '',
  messages: [{ role: 'assistant', text: 'May I run the tests?', at: '' }],
  canInterrupt: true,
  pending: { kind: 'approval', requestId: 'req', requestKind: 'command', prompt: 'npm test', options: [{ decision: 'accept', label: 'Approve' }, { decision: 'decline', label: 'Deny' }] },
};

function harness() {
  const bridge = {
    onEvenHubEvent: vi.fn(() => () => {}),
    createStartUpPageContainer: vi.fn(async () => StartUpPageCreateResult.success),
    rebuildPageContainer: vi.fn(async () => true),
    textContainerUpgrade: vi.fn(async () => true),
    audioControl: vi.fn(async () => true),
  } as unknown as EvenAppBridge;
  const api = {
    health: vi.fn(async () => ({ ok: true, version: 'test', protocol: 1, transcription: true })),
    envs: vi.fn(async () => [{ id: 'm4', label: 'M4', connected: true, threadCount: 1, attention: { approval: 1, question: 0, failed: 0, running: 0 } }]),
    threads: vi.fn(async () => [detail]),
    thread: vi.fn(async () => detail),
    approval: vi.fn(async () => ({ ok: true })),
  } as unknown as BridgeApi;
  return { bridge, api, app: new GlassesApp(bridge, api) };
}

const click = (index = 0) => ({ listEvent: new List_ItemEvent({ currentSelectItemIndex: index }) });

describe('state machine', () => {
  it('closes a card before leaving a thread', () => {
    let s = transition(initialState(), { type: 'OPEN_COMPUTERS' });
    s = transition(s, { type: 'OPEN_THREADS', env: 'm4' });
    s = transition(s, { type: 'OPEN_THREAD', detail });
    s = transition(s, { type: 'SHOW_CARD', card: { kind: 'notice', text: 'hi' } });
    s = transition(s, { type: 'BACK' });
    expect(s.screen).toBe('Thread');
    expect(s.card).toBeUndefined();
    expect(transition(s, { type: 'BACK' }).screen).toBe('Threads');
  });
  it('never pages before the newest page', () => {
    expect(transition(initialState(), { type: 'PAGE', delta: -1 }).page).toBe(0);
  });
});

describe('glasses app', () => {
  it('opens a thread and approves from the card', async () => {
    const { app, api } = harness();
    await app.start();
    await app.handle(click(0)); // first thread on Home
    expect(app.state.screen).toBe('Thread');
    // A tap on the body arrives as a system event without an eventType.
    await app.handle({ sysEvent: new Sys_ItemEvent({ eventSource: 1 }) });
    expect(app.state.card?.kind).toBe('actions');
    await app.handle(click(0)); // Approve
    expect(api.approval).toHaveBeenCalledWith('m4', 'one', { requestId: 'req', decision: 'accept' });
    expect(app.state.card).toEqual({ kind: 'notice', text: '• Approved' });
    await app.stop();
  });

  it('pages history on scroll past the ends and goes back on double click', async () => {
    const { app } = harness();
    await app.start();
    await app.handle(click(0));
    await app.handle({ sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.SCROLL_TOP_EVENT }) });
    expect(app.state.page).toBe(1);
    await app.handle({ sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.DOUBLE_CLICK_EVENT }) });
    expect(app.state.screen).toBe('Home');
    await app.stop();
  });

  it('reaches a computer through the Computers row and returns there', async () => {
    const { app } = harness();
    await app.start();
    await app.handle(click(1)); // the Computers row after one thread
    expect(app.state.screen).toBe('Computers');
    await app.handle(click(0)); // M4
    expect(app.state.screen).toBe('Threads');
    await app.handle(click(0));
    expect(app.state.screen).toBe('Thread');
    const back = { sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.DOUBLE_CLICK_EVENT }) };
    await app.handle(back);
    expect(app.state.screen).toBe('Threads');
    await app.handle(back);
    expect(app.state.screen).toBe('Computers');
    await app.handle(back);
    expect(app.state.screen).toBe('Home');
    await app.stop();
  });
});
