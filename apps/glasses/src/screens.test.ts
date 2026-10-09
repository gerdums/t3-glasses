import { describe, expect, it, vi } from 'vitest';
import { OsEventTypeList, StartUpPageCreateResult, List_ItemEvent, Text_ItemEvent, Sys_ItemEvent, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import type { BridgeApi } from './api';
import { GlassesApp } from './app';
import { initialState, transition } from './screens';
const detail = { envId: 'studio', envLabel: 'M4', id: 'one', title: 'Task', projectTitle: 'T3', status: 'running', attention: 'running' as const, updatedAt: '', messages: [], canInterrupt: true };
describe('screen transitions', () => {
  it('navigates back through actions and pauses in background', () => { let s = initialState(); s = transition(s, { type: 'OPEN_THREADS' }); s = transition(s, { type: 'OPEN_THREAD', detail }); s = transition(s, { type: 'OPEN_ACTIONS' }); expect(transition(s, { type: 'BACK' }).screen).toBe('Thread'); expect(transition(s, { type: 'FOREGROUND_EXIT' }).foreground).toBe(false); });
  it('handles SDK click events with mocked bridge and API', async () => {
    let callback: ((event: unknown) => void) | undefined;
    const bridge = { onEvenHubEvent: vi.fn(cb => { callback = cb; return () => {}; }), createStartUpPageContainer: vi.fn(async () => StartUpPageCreateResult.success), rebuildPageContainer: vi.fn(async () => true), textContainerUpgrade: vi.fn(async () => true), audioControl: vi.fn(async () => true) } as unknown as EvenAppBridge;
    const api = { health: vi.fn(async () => ({ ok: true, version: 'mock', protocol: 1, transcription: true })), envs: vi.fn(async () => []), threads: vi.fn(async () => [detail]), thread: vi.fn(async () => detail) } as unknown as BridgeApi;
    const app = new GlassesApp(bridge, api); await app.start();
    await app.handle({ listEvent: new List_ItemEvent({ eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: 0 }) }); expect(app.state.screen).toBe('Threads');
    await app.handle({ listEvent: new List_ItemEvent({ eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: 0 }) }); expect(app.state.screen).toBe('Thread');
    await app.handle({ textEvent: new Text_ItemEvent({}) }); expect(app.state.screen).toBe('Actions');
    await app.handle({ sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT }) }); expect(app.state.foreground).toBe(false);
    expect(callback).toBeDefined(); await app.stop();
  });
});
