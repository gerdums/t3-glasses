import type { EnvSummary, ThreadDetail, ThreadSummary } from '@t3-glasses/protocol';
import type { ActionItem } from './render';

export type Screen = 'Home' | 'Threads' | 'Thread' | 'Actions' | 'Voice' | 'Confirm';
export interface State {
  screen: Screen;
  foreground: boolean;
  envs: EnvSummary[];
  threads: ThreadSummary[];
  detail?: ThreadDetail;
  envFilter?: string;
  selected: number;
  actions: ActionItem[];
  voiceTarget: 'reply' | 'answer';
  transcript: string;
  recording: boolean;
  confirm: string;
  connection: string;
}
export type Intent = { type: 'OPEN_HOME' | 'OPEN_ACTIONS' | 'BACK' | 'START_VOICE' | 'STOP_VOICE' | 'FOREGROUND_ENTER' | 'FOREGROUND_EXIT' } | { type: 'OPEN_THREADS'; env?: string } | { type: 'OPEN_THREAD'; detail: ThreadDetail } | { type: 'SELECT'; index: number } | { type: 'ENVS'; envs: EnvSummary[] } | { type: 'THREADS'; threads: ThreadSummary[] } | { type: 'DETAIL'; detail: ThreadDetail } | { type: 'ACTIONS'; actions: ActionItem[] } | { type: 'TRANSCRIPT'; text: string } | { type: 'CONFIRM'; text: string } | { type: 'CONNECTION'; text: string } | { type: 'VOICE_TARGET'; target: 'reply' | 'answer' };
export const initialState = (): State => ({ screen: 'Home', foreground: true, envs: [], threads: [], selected: 0, actions: [], voiceTarget: 'reply', transcript: '', recording: false, confirm: '', connection: 'Connecting...' });
export function transition(state: State, intent: Intent): State {
  switch (intent.type) {
    case 'OPEN_HOME': return { ...state, screen: 'Home', selected: 0, envFilter: undefined };
    case 'OPEN_THREADS': return { ...state, screen: 'Threads', envFilter: intent.env, selected: 0, threads: [] };
    case 'OPEN_THREAD': return { ...state, screen: 'Thread', detail: intent.detail, selected: 0 };
    case 'OPEN_ACTIONS': return state.detail ? { ...state, screen: 'Actions', selected: 0 } : state;
    case 'BACK': return { ...state, screen: state.screen === 'Actions' || state.screen === 'Voice' || state.screen === 'Confirm' ? 'Thread' : state.screen === 'Thread' ? 'Threads' : state.screen === 'Threads' ? 'Home' : 'Home', selected: 0, recording: false };
    case 'START_VOICE': return { ...state, screen: 'Voice', transcript: '', recording: true };
    case 'STOP_VOICE': return { ...state, recording: false };
    case 'FOREGROUND_ENTER': return { ...state, foreground: true };
    case 'FOREGROUND_EXIT': return { ...state, foreground: false };
    case 'SELECT': return { ...state, selected: Math.max(0, intent.index) };
    case 'ENVS': return { ...state, envs: intent.envs };
    case 'THREADS': return { ...state, threads: intent.threads };
    case 'DETAIL': return { ...state, detail: intent.detail };
    case 'ACTIONS': return { ...state, actions: intent.actions };
    case 'TRANSCRIPT': return { ...state, transcript: intent.text };
    case 'CONFIRM': return { ...state, screen: 'Confirm', confirm: intent.text, recording: false };
    case 'CONNECTION': return { ...state, connection: intent.text };
    case 'VOICE_TARGET': return { ...state, voiceTarget: intent.target };
  }
}
