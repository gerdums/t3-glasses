import { describe, expect, it } from 'vitest';
import { getTextWidth } from '@evenrealities/pretext';
import type { EnvSummary, ThreadDetail, ThreadSummary } from '@t3-glasses/protocol';
import {
  BODY_LINES,
  BODY_WRAP_PX,
  MAX_TEXT_BYTES,
  actionItems,
  computersPage,
  conversationLines,
  conversationPage,
  homePage,
  menu,
  plainText,
  sanitize,
  threadPage,
  threadsPage,
  wrap,
} from './render';

const approval: ThreadDetail = {
  envId: 'm4',
  envLabel: 'M4 Studio',
  id: '1',
  title: 'Fix the flaky login test',
  projectTitle: 't3code',
  status: 'running',
  attention: 'approval',
  updatedAt: '',
  messages: [
    { role: 'user', text: 'Please fix the flaky login test.', at: '' },
    { role: 'assistant', text: 'Looking at it now. '.repeat(40), at: '' },
  ],
  canInterrupt: true,
  pending: {
    kind: 'approval',
    requestId: 'r',
    requestKind: 'command',
    prompt: 'npm test -- login',
    options: [
      { decision: 'accept', label: 'Approve' },
      { decision: 'acceptForSession', label: 'Approve for session' },
      { decision: 'decline', label: 'Deny' },
    ],
  },
};

const envs: EnvSummary[] = [
  { id: 'm4', label: 'M4 Studio', connected: true, threadCount: 3, attention: { approval: 1, question: 0, failed: 0, running: 2 } },
  { id: 'work', label: 'work-laptop', connected: false, threadCount: 0, attention: { approval: 0, question: 0, failed: 0, running: 0 } },
];

const allText = (page: ReturnType<typeof homePage>) => (page.textObject ?? []).map((t) => t.content).join('\n');

describe('text', () => {
  it('keeps glyphs the firmware draws and maps the rest', () => {
    expect(sanitize('Sam’s “Mac” — ok ✓ ⚠')).toBe('Sam’s “Mac” — ok • !');
  });
  it('wraps within the pixel budget', () => {
    for (const line of wrap('The quick brown fox jumps over the lazy dog. '.repeat(10), BODY_WRAP_PX)) {
      expect(getTextWidth(line)).toBeLessThanOrEqual(BODY_WRAP_PX);
    }
  });
});

describe('markdown', () => {
  it('renders as plain prose', () => {
    expect(plainText('## Done\n- **1.8** shipped with `npm test`\n- See [the PR](https://x.y/1)')).toBe(
      'Done\n\u2022 1.8 shipped with npm test\n\u2022 See the PR',
    );
  });
});

describe('conversation paging', () => {
  it('shows the newest lines first and pages back in time', () => {
    const lines = conversationLines(approval);
    expect(lines[0]).toBe('› Please fix the flaky login test.');
    const newest = conversationPage(lines, 0);
    expect(newest.text.split('\n')).toHaveLength(BODY_LINES);
    // The newest page starts mid-message, so it is marked as a continuation.
    expect(newest.text).toBe(`\u2026${lines.slice(-BODY_LINES).join('\n')}`);
    expect(conversationPage(lines, 99).index).toBe(newest.pages - 1);
  });
});

describe('screens', () => {
  it('home lists every thread with a Computers row, within the container budget', () => {
    const summary: ThreadSummary = { ...approval };
    const page = homePage([summary], envs, '\u2022 Connected');
    const rows = page.listObject?.[0]?.itemContainer?.itemName ?? [];
    expect(rows[0]).toContain('\u25c6 M4 Studio \u203a Fix');
    expect(rows.at(-1)).toContain('Computers \u00b7 1/2 online');
    expect(page.listObject?.[0]?.itemContainer?.isItemSelectBorderEn).toBe(1);
    expect((page.textObject?.length ?? 0) + (page.listObject?.length ?? 0)).toBeLessThanOrEqual(8);
    expect(allText(page)).toContain('1 needs you');
  });

  it('computers page lists every environment', () => {
    const rows = computersPage(envs, '').listObject?.[0]?.itemContainer?.itemName ?? [];
    expect(rows[0]).toContain('M4 Studio \u00b7 1 needs you, 2 running');
    expect(rows[1]).toContain('work-laptop \u00b7 offline');
  });

  it('keeps list rows within the 63-byte firmware limit', () => {
    const long: ThreadSummary = { ...approval, title: '\u25c6\u203a'.repeat(40) };
    for (const row of threadsPage([long], 'Inbox', true).listObject?.[0]?.itemContainer?.itemName ?? []) {
      expect(new TextEncoder().encode(row).length).toBeLessThanOrEqual(63);
    }
  });

  it('threads page marks attention', () => {
    const summary: ThreadSummary = { ...approval };
    const page = threadsPage([summary], 'Inbox', true);
    expect(page.listObject?.[0]?.itemContainer?.itemName?.[0]).toContain('◆ M4 Studio › Fix');
  });

  it('thread page captures input on the body and stays within limits', () => {
    const page = threadPage(approval);
    const capture = [...(page.textObject ?? []), ...(page.listObject ?? [])].filter((c) => c.isEventCapture === 1);
    expect(capture).toHaveLength(1);
    for (const t of page.textObject ?? []) expect(new TextEncoder().encode(t.content).length).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(allText(page)).toContain('Needs approval');
    expect(page.textObject?.length).toBeLessThanOrEqual(8);
  });

  it('approval card shows the request and offers its options in a list', () => {
    const page = threadPage(approval, { card: { kind: 'actions', items: actionItems(approval) } });
    const card = page.textObject?.find((t) => t.containerName === 'card');
    expect(card?.content).toContain('Approve? npm test -- login');
    expect(page.listObject?.[0]?.itemContainer?.itemName?.slice(0, 3)).toEqual(['Approve', 'Approve for session', 'Deny']);
    expect(page.listObject?.[0]?.isEventCapture).toBe(1);
    expect((page.textObject?.length ?? 0) + (page.listObject?.length ?? 0)).toBeLessThanOrEqual(8);
    // The card stays below the title row and draws over the body.
    expect(card!.yPosition!).toBeGreaterThanOrEqual(44);
    const body = page.textObject?.find((t) => t.containerName === 'body');
    expect(card!.zOrderIndex!).toBeGreaterThan(body!.zOrderIndex!);
  });

  it('menus fit the firmware limits', () => {
    const items = actionItems(approval);
    expect(items.length).toBeLessThanOrEqual(10);
    expect(menu(items).menuItems?.every((item, i) => item.itemID === i + 1 && new TextEncoder().encode(item.itemName!).length <= 32)).toBe(true);
  });
});

describe('cards', () => {
  it('keeps body text out from under the card', () => {
    const notice = threadPage(approval, { card: { kind: 'notice', text: 'Approved' } });
    const card = notice.textObject!.find((t) => t.containerName === 'card')!;
    const body = notice.textObject!.find((t) => t.containerName === 'body')!;
    expect(body.yPosition! + body.height!).toBeLessThanOrEqual(card.yPosition!);
    const lines = body.content!.split('\n').length;
    expect(lines * 27).toBeLessThanOrEqual(body.height!);
  });
});
