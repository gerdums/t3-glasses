import type { Attention, EnvSummary, ThreadDetail, ThreadSummary } from '@t3-glasses/protocol';
import { ListContainerProperty, ListItemContainerProperty, MenuContainerProperty, MenuItemProperty, RebuildPageContainer, TextContainerProperty } from '@evenrealities/even_hub_sdk';

export type Action = { kind: 'approval'; decision: 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel' } | { kind: 'showRequest' | 'dictateAnswer' | 'reply' | 'interrupt' | 'refresh' | 'back' } | { kind: 'answer'; questionId: string; label: string };
export type ActionItem = { label: string; action: Action };
export type Page = RebuildPageContainer;
export const ascii = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E\n]/g, '?');
export const trim = (s: string, max: number) => { const value = ascii(s).replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value; };
const marker: Record<Attention, string> = { approval: '[!]', question: '[?]', failed: '[x]', running: '[>]', done: '[.]', idle: '' };
const text = (id: number, name: string, content: string, y: number, height: number, capture = 0): TextContainerProperty => new TextContainerProperty({ xPosition: 0, yPosition: y, width: 576, height, containerID: id, containerName: name, content: ascii(content).slice(0, 1000), isEventCapture: capture });
const list = (rows: string[], height = 248): ListContainerProperty => new ListContainerProperty({ xPosition: 0, yPosition: 0, width: 576, height, containerID: 1, containerName: 'rows', itemContainer: new ListItemContainerProperty({ itemCount: Math.min(rows.length, 20), itemName: rows.slice(0, 20).map(row => trim(row, 63)) }), isEventCapture: 1 });
const listPage = (rows: string[], status: string): Page => new RebuildPageContainer({ containerTotalNum: 2, listObject: [list(rows.length ? rows : ['(empty)'])], textObject: [text(2, 'status', status, 248, 40)] });
export function homePage(envs: EnvSummary[], inboxCount: number, connection: string): Page {
  const rows = [`Inbox (${inboxCount})`, ...envs.map(env => env.connected ? `[!${env.attention.approval} ?${env.attention.question} >${env.attention.running}] ${env.label}` : `(offline) ${env.label}`)];
  return listPage(rows, connection);
}
export function threadsPage(threads: ThreadSummary[], title: string): Page {
  return listPage(threads.map(t => `${marker[t.attention]} ${t.projectTitle}: ${t.title}`.trim()), `${trim(title, 52)}  Double: back`);
}
export function threadText(thread: ThreadDetail, max = 1000): string {
  const lines = thread.messages.filter(m => m.role !== 'system').map(m => `${m.role === 'user' ? '> ' : ''}${ascii(m.text)}`);
  if (thread.activity && thread.attention === 'running') lines.push(`* ${ascii(thread.activity)}`);
  const whole = lines.join('\n\n');
  return whole.length <= max ? whole : `...\n${whole.slice(-(max - 4))}`;
}
export function actionItems(thread: ThreadDetail): ActionItem[] {
  const items: ActionItem[] = [];
  const pending = thread.pending;
  if (pending?.kind === 'approval') {
    for (const option of pending.options) items.push({ label: trim(option.label, 32), action: { kind: 'approval', decision: option.decision } });
    items.push({ label: 'Show request', action: { kind: 'showRequest' } });
  } else if (pending?.kind === 'question') {
    const question = pending.questions[0];
    if (question) {
      for (const option of question.options.slice(0, thread.canInterrupt ? 5 : 6)) items.push({ label: trim(option.label, 32), action: { kind: 'answer', questionId: question.id, label: option.label } });
      items.push({ label: 'Dictate answer', action: { kind: 'dictateAnswer' } });
    }
  }
  const universal: ActionItem[] = [{ label: 'Reply by voice', action: { kind: 'reply' } }];
  if (thread.canInterrupt) universal.push({ label: 'Interrupt', action: { kind: 'interrupt' } });
  universal.push({ label: 'Refresh', action: { kind: 'refresh' } }, { label: 'Back', action: { kind: 'back' } });
  return [...items.slice(0, 10 - universal.length), ...universal];
}
export function menu(items: ActionItem[]): MenuContainerProperty { return new MenuContainerProperty({ menuItems: items.map((item, index) => new MenuItemProperty({ itemID: index + 1, itemName: trim(item.label, 32) })) }); }
export function threadPage(thread: ThreadDetail, actions = actionItems(thread)): Page {
  return new RebuildPageContainer({ containerTotalNum: 2, textObject: [text(1, 'thread', threadText(thread), 0, 248, 1), text(2, 'status', `${thread.status} | ${thread.envLabel} | Click: actions`, 248, 40)], menuObject: menu(actions) });
}
export function actionsPage(items: ActionItem[]): Page { return listPage(items.map(item => item.label), 'Actions  Double: back'); }
export function messagePage(content: string): Page { return new RebuildPageContainer({ containerTotalNum: 1, textObject: [text(1, 'message', content, 0, 288, 1)] }); }
