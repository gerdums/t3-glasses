/**
 * Glasses UI, modeled on Even Terminal: a rounded panel with a title row,
 * hairline dividers, a body, and a footer with status on the left and a dim
 * hint on the right. Choices appear in an inset card with native list
 * selection. Pure functions: protocol data in, page containers out.
 *
 * Budget: a page holds at most 8 text/list containers. The card and its list
 * replace the title meta and header divider while open.
 */
import type { Attention, EnvSummary, ThreadDetail, ThreadSummary } from '@t3-glasses/protocol';
import {
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  TextContainerProperty,
} from '@evenrealities/even_hub_sdk';
import { getAdvW, getTextWidth, pxTruncate } from '@evenrealities/pretext';

export type Action =
  | { kind: 'approval'; decision: 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel' }
  | { kind: 'dictateAnswer' | 'reply' | 'interrupt' | 'refresh' | 'back' | 'send' | 'cancelVoice' }
  | { kind: 'answer'; questionId: string; label: string };
export type ActionItem = { label: string; action: Action };
export type Page = RebuildPageContainer;

/** Firmware and simulator reject text containers over 999 bytes. */
export const MAX_TEXT_BYTES = 990;
export const LINE_HEIGHT = 27;
/** List item labels are limited to 63 UTF-8 bytes. */
export const MAX_ITEM_BYTES = 63;

// ---- Layout (576 x 288) ------------------------------------------------------

const PANEL = { x: 4, y: 4, w: 568, h: 280 };
const INSET = 16; // panel edge to content
const CONTENT_X = PANEL.x + INSET;
const CONTENT_W = PANEL.w - INSET * 2;
const RIGHT_EDGE = CONTENT_X + CONTENT_W;
const TITLE_Y = 9;
const HEADER_RULE_Y = 44;
const BODY_Y = 50;
const BODY_H = 184;
export const BODY_LINES = Math.floor(BODY_H / LINE_HEIGHT);
/** Wrap a little inside the container so firmware wrapping never disagrees. */
export const BODY_WRAP_PX = CONTENT_W - 12;
const FOOTER_RULE_Y = 238;
const FOOTER_Y = 244;
const FOOTER_H = 34;

const BRIGHT = 4;
const DIM = 2;
const RULE_COLOR = 6;
const PANEL_COLOR = 11;
const CARD_COLOR = 15;

/**
 * Stable ids and names so in-place text upgrades target the same containers.
 * zOrderIndex follows the id, so the card and list (highest) draw over the body.
 */
const ID = { panel: 1, title: 2, meta: 3, rule: 4, body: 5, footRule: 6, status: 7, hint: 8, card: 9, list: 10 } as const;

// ---- Text --------------------------------------------------------------------

const REPLACEMENTS: Record<string, string> = {
  '✓': '•', // check mark -> bullet
  '✔': '•',
  '✗': '×',
  '⚠': '!',
  '⏎': '',
  '↵': '',
  '▸': '›',
  '⋯': '…',
  ' ': ' ',
  '\t': '  ',
};

/** Keeps characters the firmware font can draw; maps or drops the rest. */
export function sanitize(text: string): string {
  let out = '';
  for (const char of text.normalize('NFC')) {
    if (char === '\n') {
      out += char;
      continue;
    }
    const replacement = REPLACEMENTS[char];
    if (replacement !== undefined) {
      out += replacement;
      continue;
    }
    if (getAdvW(char.codePointAt(0)!) > 0) out += char;
  }
  return out;
}

export function oneLine(text: string, maxPx: number): string {
  return pxTruncate(sanitize(text).replace(/\s+/g, ' ').trim(), maxPx);
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Trims from the end to fit the firmware byte limit. */
function fitBytes(text: string, max = MAX_TEXT_BYTES): string {
  if (utf8Bytes(text) <= max) return text;
  const chars = [...text];
  while (chars.length && utf8Bytes(`${chars.join('').trimEnd()}\u2026`) > max) chars.pop();
  return `${chars.join('').trimEnd()}\u2026`;
}

/** Greedy word wrap with firmware glyph widths; long words break by glyph. */
export function wrap(text: string, maxPx: number): string[] {
  const lines: string[] = [];
  for (const paragraph of sanitize(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/ +/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (getTextWidth(candidate) <= maxPx) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      let rest = word;
      while (getTextWidth(rest) > maxPx) {
        let take = rest.length;
        while (take > 1 && getTextWidth(rest.slice(0, take)) > maxPx) take -= 1;
        lines.push(rest.slice(0, take));
        rest = rest.slice(take);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

// ---- Primitives --------------------------------------------------------------

function text(
  id: number,
  name: string,
  box: { x: number; y: number; w: number; h: number },
  content: string,
  style: { color?: number; border?: number; borderColor?: number; radius?: number; padding?: number; capture?: boolean } = {},
): TextContainerProperty {
  return new TextContainerProperty({
    containerID: id,
    containerName: name,
    xPosition: box.x,
    yPosition: box.y,
    width: box.w,
    height: box.h,
    content: fitBytes(content || ' '),
    textColor: style.color ?? BRIGHT,
    borderWidth: style.border ?? 0,
    borderColor: style.borderColor ?? 0,
    borderRadius: style.radius ?? 0,
    paddingLength: style.padding ?? 0,
    isEventCapture: style.capture ? 1 : 0,
    zOrderIndex: id,
  });
}

function rule(id: number, name: string, y: number): TextContainerProperty {
  return text(id, name, { x: PANEL.x + 12, y, w: PANEL.w - 24, h: 2 }, ' ', { border: 1, borderColor: RULE_COLOR });
}

function list(id: number, box: { x: number; y: number; w: number; h: number }, rows: string[]): ListContainerProperty {
  const items = (rows.length ? rows : ['Nothing here']).slice(0, 20).map((row) => fitBytes(oneLine(row, box.w - 28), MAX_ITEM_BYTES) || ' ');
  return new ListContainerProperty({
    containerID: id,
    containerName: 'list',
    xPosition: box.x,
    yPosition: box.y,
    width: box.w,
    height: box.h,
    isEventCapture: 1,
    zOrderIndex: id,
    itemContainer: new ListItemContainerProperty({ itemCount: items.length, isItemSelectBorderEn: 1, itemName: items }),
  });
}

/** A right-aligned single line ending at the content edge. */
function rightAligned(id: number, name: string, y: number, h: number, content: string, maxPx: number, color: number) {
  const line = oneLine(content, maxPx);
  const width = Math.min(getTextWidth(line) + 8, maxPx + 8);
  return text(id, name, { x: RIGHT_EDGE - width, y, w: width, h }, line, { color });
}

export interface Chrome {
  title: string;
  meta?: string;
  status: string;
  hint: string;
}

/** Panel, title row, header rule (or card), footer rule, status, and hint. */
function chrome(c: Chrome, withHeaderRule: boolean): TextContainerProperty[] {
  const hint = oneLine(c.hint, 230);
  const hintWidth = getTextWidth(hint);
  const statusMax = CONTENT_W - hintWidth - 24;
  const parts = [
    text(ID.panel, 'panel', { x: PANEL.x, y: PANEL.y, w: PANEL.w, h: PANEL.h }, ' ', {
      border: 2,
      borderColor: PANEL_COLOR,
      radius: 10,
    }),
    text(ID.title, 'title', { x: CONTENT_X, y: TITLE_Y, w: 380, h: 32 }, oneLine(c.title, c.meta ? 340 : CONTENT_W)),
    text(ID.footRule, 'footrule', { x: PANEL.x + 12, y: FOOTER_RULE_Y, w: PANEL.w - 24, h: 2 }, ' ', {
      border: 1,
      borderColor: RULE_COLOR,
    }),
    text(ID.status, 'status', { x: CONTENT_X, y: FOOTER_Y, w: statusMax + 8, h: FOOTER_H }, oneLine(c.status, statusMax)),
    rightAligned(ID.hint, 'hint', FOOTER_Y, FOOTER_H, hint, 230, DIM),
  ];
  if (withHeaderRule) {
    parts.push(rule(ID.rule, 'rule', HEADER_RULE_Y));
    if (c.meta) parts.push(rightAligned(ID.meta, 'meta', TITLE_Y, 32, c.meta, 180, DIM));
  }
  return parts;
}

function page(textObject: TextContainerProperty[], listObject: ListContainerProperty[] = [], menu?: MenuContainerProperty): Page {
  return new RebuildPageContainer({
    containerTotalNum: textObject.length + listObject.length,
    textObject: [...textObject].sort((a, b) => a.containerID! - b.containerID!),
    ...(listObject.length ? { listObject } : {}),
    ...(menu ? { menuObject: menu } : {}),
  });
}

// ---- Vocabulary --------------------------------------------------------------

const MARK: Record<Attention, string> = {
  approval: '◆', // ◆ needs you
  question: '◆',
  failed: '×', // ×
  running: '»', // »
  done: '•', // •
  idle: '·', // ·
};

export function statusLine(thread: Pick<ThreadDetail, 'attention' | 'activity' | 'pending'>): string {
  switch (thread.attention) {
    case 'approval':
      return '◆ Needs approval';
    case 'question':
      return '◆ Question for you';
    case 'running':
      return `» ${thread.activity ?? 'Thinking…'}`;
    case 'failed':
      return '× Run failed';
    default:
      return '• Waiting for input';
  }
}

function needsYou(counts: EnvSummary['attention']): number {
  return counts.approval + counts.question;
}

function envRow(env: EnvSummary): string {
  if (!env.connected) return `× ${env.label} · offline`;
  const parts: string[] = [];
  const needs = needsYou(env.attention);
  if (needs) parts.push(`${needs} need${needs === 1 ? 's' : ''} you`);
  if (env.attention.running) parts.push(`${env.attention.running} running`);
  if (env.attention.failed) parts.push(`${env.attention.failed} failed`);
  const mark = needs ? MARK.approval : env.attention.running ? MARK.running : MARK.done;
  return `${mark} ${env.label}${parts.length ? ` · ${parts.join(', ')}` : ''}`;
}

export function threadRow(thread: ThreadSummary, showEnv: boolean): string {
  const where = showEnv ? thread.envLabel : thread.projectTitle;
  const prefix = where && where !== 'No project' ? `${where} › ` : '';
  return `${MARK[thread.attention]} ${prefix}${thread.title}`;
}

// ---- Screens -----------------------------------------------------------------

const LIST_BOX = { x: PANEL.x + 10, y: BODY_Y, w: PANEL.w - 20, h: BODY_H };

export function homePage(envs: EnvSummary[], inbox: ThreadSummary[] | number, connection: string): Page {
  const online = envs.filter((env) => env.connected).length;
  const needs = envs.reduce((sum, env) => sum + needsYou(env.attention), 0);
  const inboxCount = typeof inbox === 'number' ? inbox : inbox.length;
  const rows = [
    `${needs ? MARK.approval : MARK.done} Inbox · ${needs ? `${needs} need${needs === 1 ? 's' : ''} you` : inboxCount ? `${inboxCount} active` : 'all clear'}`,
    ...envs.map(envRow),
  ];
  return page(
    chrome(
      {
        title: 'T3 Code',
        meta: `${online}/${envs.length} online`,
        status: connection,
        hint: '[Tap open]',
      },
      true,
    ),
    [list(ID.list, LIST_BOX, rows)],
  );
}

export function threadsPage(threads: ThreadSummary[], title: string, showEnv: boolean): Page {
  const needs = threads.filter((t) => t.attention === 'approval' || t.attention === 'question').length;
  const running = threads.filter((t) => t.attention === 'running').length;
  const status = needs
    ? `${MARK.approval} ${needs} need${needs === 1 ? 's' : ''} you`
    : running
      ? `${MARK.running} ${running} running`
      : `${MARK.done} All clear`;
  return page(
    chrome({ title, meta: `${threads.length} thread${threads.length === 1 ? '' : 's'}`, status, hint: '[Tap open · Dbl back]' }, true),
    [list(ID.list, LIST_BOX, threads.length ? threads.map((t) => threadRow(t, showEnv)) : ['Nothing needs you right now'])],
  );
}

/** Conversation as wrapped lines, oldest first; user turns start with a chevron. */
export function conversationLines(thread: ThreadDetail): string[] {
  const lines: string[] = [];
  for (const message of thread.messages) {
    if (message.role === 'system' || !message.text.trim()) continue;
    if (lines.length) lines.push('');
    const body = message.role === 'user' ? `› ${message.text.trim()}` : message.text.trim();
    lines.push(...wrap(body, BODY_WRAP_PX));
  }
  return lines;
}

/** One screen of conversation. Page 0 is the newest; higher pages go back in time. */
export function conversationPage(lines: string[], pageIndex: number, linesPerPage = BODY_LINES) {
  const pages = Math.max(1, Math.ceil(lines.length / linesPerPage));
  const index = Math.min(Math.max(pageIndex, 0), pages - 1);
  const end = lines.length - index * linesPerPage;
  const start = Math.max(0, end - linesPerPage);
  const shown = lines.slice(start, end);
  // Mark a page that starts mid-message.
  if (start > 0 && lines[start - 1] !== '' && shown[0]) shown[0] = `\u2026${shown[0]}`;
  return { text: shown.join('\n'), index, pages };
}

export function actionItems(thread: ThreadDetail): ActionItem[] {
  const items: ActionItem[] = [];
  const pending = thread.pending;
  if (pending?.kind === 'approval') {
    for (const option of pending.options) items.push({ label: option.label, action: { kind: 'approval', decision: option.decision } });
  } else if (pending?.kind === 'question') {
    const question = pending.questions[0];
    for (const option of question?.options.slice(0, 6) ?? []) {
      items.push({ label: option.label, action: { kind: 'answer', questionId: question!.id, label: option.label } });
    }
    items.push({ label: 'Speak an answer', action: { kind: 'dictateAnswer' } });
  }
  items.push({ label: 'Reply by voice', action: { kind: 'reply' } });
  if (thread.canInterrupt) items.push({ label: 'Interrupt', action: { kind: 'interrupt' } });
  items.push({ label: 'Back', action: { kind: 'back' } });
  return items.slice(0, 10);
}

export function menu(items: ActionItem[]): MenuContainerProperty {
  return new MenuContainerProperty({
    menuItems: items.map((item, index) => new MenuItemProperty({ itemID: index + 1, itemName: oneLine(item.label, 200).slice(0, 30) })),
  });
}

export type Card =
  | { kind: 'actions'; items: ActionItem[] }
  | { kind: 'listening' }
  | { kind: 'transcribing' }
  | { kind: 'transcript'; text: string }
  | { kind: 'notice'; text: string };

export const TRANSCRIPT_ITEMS: ActionItem[] = [
  { label: 'Send', action: { kind: 'send' } },
  { label: 'Cancel', action: { kind: 'cancelVoice' } },
];

function cardHeading(thread: ThreadDetail, card: Card): string {
  switch (card.kind) {
    case 'actions': {
      const pending = thread.pending;
      if (pending?.kind === 'approval') return `Approve? ${pending.prompt}`;
      if (pending?.kind === 'question') return pending.questions[0]?.question ?? 'Question';
      return 'Actions';
    }
    case 'listening':
      return '“ Listening… release to stop';
    case 'transcribing':
      return '“ Transcribing…';
    case 'transcript':
      return `“ ${card.text}”`;
    case 'notice':
      return card.text;
  }
}

function cardItems(card: Card): ActionItem[] {
  if (card.kind === 'actions') return card.items;
  if (card.kind === 'transcript') return TRANSCRIPT_ITEMS;
  return [];
}

export function threadPage(thread: ThreadDetail, options: { page?: number; card?: Card; items?: ActionItem[] } = {}): Page {
  const lines = conversationLines(thread);
  const view = conversationPage(lines, options.page ?? 0);
  const card = options.card;
  const items = card ? cardItems(card) : [];
  const status = card?.kind === 'listening' ? '• Listening' : view.index > 0 ? `↑ ${view.index + 1}/${view.pages} · ${statusLine(thread)}` : statusLine(thread);
  const hint = !card
    ? thread.pending
      ? '[Tap respond]'
      : '[Tap act · Hold talk]'
    : items.length
      ? '[Tap pick · Dbl close]'
      : card.kind === 'listening'
        ? '[Release]'
        : '';
  const base = chrome({ title: thread.title, meta: thread.envLabel, status, hint }, !card);
  const bodyText = view.text || 'No messages yet.';
  if (!card) {
    const body = text(ID.body, 'body', { x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: BODY_H }, bodyText, { capture: true });
    return page([...base, body], [], menu(options.items ?? actionItems(thread)));
  }

  // Inset card anchored above the footer; its heading wraps to at most three lines.
  const headingLines = wrap(cardHeading(thread, card), CONTENT_W - 40).slice(0, items.length ? 2 : 3);
  const headingH = headingLines.length * LINE_HEIGHT;
  // The card stays below the title row; a long list scrolls inside it.
  const maxCardH = FOOTER_RULE_Y - 6 - HEADER_RULE_Y;
  const chromeH = 16 + headingH + (items.length ? 6 : 0) + 8;
  const listH = items.length ? Math.max(44, Math.min(Math.min(items.length, 3) * 40 + 4, maxCardH - chromeH)) : 0;
  const cardH = Math.min(chromeH + listH, maxCardH);
  const cardY = FOOTER_RULE_Y - 6 - cardH;
  const cardBox = { x: CONTENT_X - 4, y: cardY, w: CONTENT_W + 8, h: cardH };
  const cardText = text(ID.card, 'card', cardBox, headingLines.join('\n'), {
    border: 2,
    borderColor: CARD_COLOR,
    radius: 8,
    padding: 8,
  });
  const lists = items.length
    ? [list(ID.list, { x: cardBox.x + 6, y: cardY + 14 + headingH, w: cardBox.w - 12, h: listH }, items.map((item) => item.label))]
    : [];
  // Containers have no fill, so the body only keeps the lines that fit above the card.
  const roomLines = Math.max(0, Math.floor((cardY - BODY_Y - 4) / LINE_HEIGHT));
  const visible = roomLines ? conversationPage(lines, view.index, roomLines).text : '';
  const body = text(ID.body, 'body', { x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: Math.max(LINE_HEIGHT, cardY - BODY_Y - 4) }, visible || ' ', {
    capture: !items.length,
    color: DIM,
  });
  return page([...base, body, cardText], lists);
}

/** Full-panel message, used before the bridge is reachable. */
export function messagePage(title: string, message: string, status = '', hint = ''): Page {
  return page([
    ...chrome({ title, status, hint }, true),
    text(ID.body, 'body', { x: CONTENT_X, y: BODY_Y, w: CONTENT_W, h: BODY_H }, wrap(message, BODY_WRAP_PX).join('\n'), { capture: true }),
  ]);
}
