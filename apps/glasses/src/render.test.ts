import { describe, expect, it } from 'vitest';
import type { ThreadDetail } from '@t3-glasses/protocol';
import { MAX_TEXT, actionItems, ascii, homePage, menu, threadPage, threadText, threadsPage } from './render';
const detail: ThreadDetail = { envId: 'studio', envLabel: 'M4', id: '1', title: 'A', projectTitle: 'T3', status: 'waiting', attention: 'approval', updatedAt: '', messages: [{ role: 'user', text: 'hello '.repeat(400), at: '' }], canInterrupt: false, pending: { kind: 'approval', requestId: 'r', requestKind: 'command', prompt: 'npm test', options: [{ decision: 'accept', label: 'Approve' }, { decision: 'decline', label: 'Deny' }] } };
describe('glasses rendering', () => {
  it('bounds ASCII text and keeps latest content', () => { const value = threadText({ ...detail, pending: undefined }); expect(value.length).toBeLessThanOrEqual(MAX_TEXT); expect(value.startsWith('> hello')).toBe(true); expect(threadPage(detail).textObject?.[0].isEventCapture).toBe(1); });
  it('renders attention rows and one capture container', () => { const page = threadsPage([{ ...detail, title: 'Café', attention: 'approval' }], 'Inbox'); expect(page.listObject?.[0].itemContainer?.itemName?.[0]).toContain('[!]'); expect(page.listObject?.[0].itemContainer?.itemName?.[0]).toContain('Cafe'); expect(page.textObject?.[0].isEventCapture).toBe(0); });
  it('limits menus and preserves universal actions', () => { const question: ThreadDetail = { ...detail, pending: { kind: 'question', requestId: 'r', questions: [{ id: 'q', question: '?', multiSelect: false, options: Array.from({ length: 20 }, (_, i) => ({ label: `Choice ${i}` })) }] } }; const items = actionItems(question); expect(items).toHaveLength(10); expect(items.at(-1)?.action.kind).toBe('back'); expect(items.some(item => item.action.kind === 'dictateAnswer')).toBe(true); expect(menu(items).menuItems?.every((item, i) => item.itemID === i + 1 && item.itemName!.length <= 32)).toBe(true); });
  it('shows environment attention counts and offline status', () => { const page = homePage([{ id: 'x', label: 'Worker', connected: false, threadCount: 0, attention: { approval: 0, question: 0, failed: 0, running: 0 } }], 2, 'Connected'); expect(page.listObject?.[0].itemContainer?.itemName).toEqual(['Inbox (2)', '(offline) Worker']); });
});
describe('pending requests and punctuation', () => {
  it('puts the approval prompt first, above long history', () => {
    const value = threadText({ ...detail, pending: { kind: 'approval', requestId: 'r', requestKind: 'command', prompt: 'rm -rf build', options: [] } });
    expect(value.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(value.startsWith('[!] APPROVE? rm -rf build')).toBe(true);
  });
  it('lists question options', () => {
    const value = threadText({ ...detail, messages: [], pending: { kind: 'question', requestId: 'r', questions: [{ id: 'q', question: 'Where?', multiSelect: false, options: [{ label: 'M4' }, { label: 'M1' }] }] } });
    expect(value).toContain('[?] Where?\n1. M4\n2. M1');
  });
  it('maps typographic punctuation to ASCII', () => {
    expect(ascii('Gareth’s MacBook — “Pro”…')).toBe('Gareth\'s MacBook - "Pro"...');
  });
});
