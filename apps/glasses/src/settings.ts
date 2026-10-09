import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';

export interface Settings {
  url: string;
  token: string;
}

const KEY = 't3-glasses-settings';

/** Build-time defaults; the bridge address is not secret, so private builds can bake it in. */
export const defaults: Settings = {
  url: import.meta.env.VITE_BRIDGE_URL || '',
  token: import.meta.env.VITE_BRIDGE_TOKEN || '',
};

export async function loadSettings(bridge: Pick<EvenAppBridge, 'getLocalStorage'>): Promise<Settings> {
  try {
    const saved = JSON.parse(await bridge.getLocalStorage(KEY)) as Partial<Settings>;
    return { url: saved.url || defaults.url, token: saved.token || defaults.token };
  } catch {
    return defaults;
  }
}

export function normalizeUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The bridge address must start with https://');
  return url.origin;
}

export async function saveSettings(bridge: Pick<EvenAppBridge, 'setLocalStorage'>, settings: Settings): Promise<void> {
  const value = JSON.stringify({ url: normalizeUrl(settings.url), token: settings.token.trim() });
  if (!(await bridge.setLocalStorage(KEY, value))) throw new Error('Could not save settings');
}

/** Trades a 6-digit pairing code for the glasses token. */
export async function pairWithCode(url: string, code: string): Promise<string> {
  const response = await fetch(`${normalizeUrl(url)}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code.replace(/\D/g, '') }),
  }).catch(() => {
    throw new Error("Can't reach the bridge. Check the address and that this phone is on your tailnet.");
  });
  const body = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!response.ok || !body.token) throw new Error(body.error || `Pairing failed (HTTP ${response.status})`);
  return body.token;
}
