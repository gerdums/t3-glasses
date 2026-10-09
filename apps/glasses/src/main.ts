import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { HttpBridgeApi } from './api';
import { GlassesApp } from './app';
import { loadSettings, saveSettings, type Settings } from './settings';

const form = document.querySelector<HTMLFormElement>('#settings')!;
const url = document.querySelector<HTMLInputElement>('#bridge-url')!;
const token = document.querySelector<HTMLInputElement>('#bridge-token')!;
const status = document.querySelector<HTMLElement>('#status')!;
const bridge = await waitForEvenAppBridge();
let settings = await loadSettings(bridge);
let app: GlassesApp | undefined;
async function connect(config: Settings) {
  if (app) await app.stop();
  if (!config.url) { status.textContent = 'Enter your bridge URL to connect.'; return; }
  app = new GlassesApp(bridge, new HttpBridgeApi(config.url, config.token));
  try { await app.start(); status.textContent = 'Glasses app ready.'; }
  catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
}
url.value = settings.url; token.value = settings.token;
form.addEventListener('submit', async event => {
  event.preventDefault();
  try { settings = { url: url.value.trim(), token: token.value.trim() }; await saveSettings(bridge, settings); await connect(settings); }
  catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
});
void connect(settings);
