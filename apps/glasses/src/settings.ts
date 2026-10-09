import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';
export interface Settings { url: string; token: string }
const KEY = 't3-glasses-settings';
export const defaults: Settings = { url: import.meta.env.VITE_BRIDGE_URL || '', token: import.meta.env.VITE_BRIDGE_TOKEN || '' };
export async function loadSettings(bridge: Pick<EvenAppBridge, 'getLocalStorage'>): Promise<Settings> {
  try { const saved = JSON.parse(await bridge.getLocalStorage(KEY)) as Partial<Settings>; return { url: saved.url || defaults.url, token: saved.token || defaults.token }; }
  catch { return defaults; }
}
export async function saveSettings(bridge: Pick<EvenAppBridge, 'setLocalStorage'>, settings: Settings): Promise<void> {
  const url = new URL(settings.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Bridge URL must use HTTP or HTTPS');
  if (!await bridge.setLocalStorage(KEY, JSON.stringify({ url: url.origin, token: settings.token.trim() }))) throw new Error('Could not save settings');
}
