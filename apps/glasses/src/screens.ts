import type { EnvSummary, ThreadDetail, ThreadSummary } from '@t3-glasses/protocol';
import type { ActionItem, Card } from './render';

/** Three places to be; actions, voice, and notices are cards over a thread. */
export type Screen = 'Home' | 'Threads' | 'Thread';

export interface State {
  screen: Screen;
  foreground: boolean;
  envs: EnvSummary[];
  inbox: ThreadSummary[];
  threads: ThreadSummary[];
  envFilter?: string;
  detail?: ThreadDetail;
  /** Conversation page; 0 is the newest. */
  page: number;
  card?: Card;
  voiceTarget: 'reply' | 'answer';
  connection: string;
}

export type Intent =
  | { type: 'OPEN_HOME' }
  | { type: 'OPEN_THREADS'; env?: string }
  | { type: 'OPEN_THREAD'; detail: ThreadDetail }
  | { type: 'BACK' }
  | { type: 'PAGE'; delta: number }
  | { type: 'SHOW_CARD'; card: Card }
  | { type: 'CLOSE_CARD' }
  | { type: 'VOICE_TARGET'; target: 'reply' | 'answer' }
  | { type: 'FOREGROUND'; foreground: boolean }
  | { type: 'ENVS'; envs: EnvSummary[]; inbox: ThreadSummary[] }
  | { type: 'THREADS'; threads: ThreadSummary[] }
  | { type: 'DETAIL'; detail: ThreadDetail }
  | { type: 'CONNECTION'; text: string };

export const initialState = (): State => ({
  screen: 'Home',
  foreground: true,
  envs: [],
  inbox: [],
  threads: [],
  page: 0,
  voiceTarget: 'reply',
  connection: '· Connecting…',
});

export function transition(state: State, intent: Intent): State {
  switch (intent.type) {
    case 'OPEN_HOME':
      return { ...state, screen: 'Home', envFilter: undefined, card: undefined };
    case 'OPEN_THREADS':
      return { ...state, screen: 'Threads', envFilter: intent.env, threads: [], card: undefined };
    case 'OPEN_THREAD':
      return { ...state, screen: 'Thread', detail: intent.detail, page: 0, card: undefined };
    case 'BACK':
      if (state.card) return { ...state, card: undefined };
      if (state.screen === 'Thread') return { ...state, screen: 'Threads', page: 0 };
      return { ...state, screen: 'Home', envFilter: undefined };
    case 'PAGE':
      return { ...state, page: Math.max(0, state.page + intent.delta) };
    case 'SHOW_CARD':
      return { ...state, card: intent.card };
    case 'CLOSE_CARD':
      return { ...state, card: undefined };
    case 'VOICE_TARGET':
      return { ...state, voiceTarget: intent.target };
    case 'FOREGROUND':
      return { ...state, foreground: intent.foreground };
    case 'ENVS':
      return { ...state, envs: intent.envs, inbox: intent.inbox };
    case 'THREADS':
      return { ...state, threads: intent.threads };
    case 'DETAIL':
      return { ...state, detail: intent.detail };
    case 'CONNECTION':
      return { ...state, connection: intent.text };
  }
}

/** Items of the card currently showing a list, if any. */
export function cardItems(state: State): ActionItem[] {
  const card = state.card;
  if (card?.kind === 'actions') return card.items;
  return [];
}
