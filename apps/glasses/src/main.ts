import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { HttpBridgeApi } from './api';
import { GlassesApp, showSetupScreen } from './app';
import { loadSettings, pairWithCode, saveSettings, type Settings } from './settings';

const form = document.querySelector<HTMLFormElement>('#pair')!;
const url = document.querySelector<HTMLInputElement>('#bridge-url')!;
const code = document.querySelector<HTMLInputElement>('#code')!;
const token = document.querySelector<HTMLInputElement>('#bridge-token')!;
const submit = document.querySelector<HTMLButtonElement>('#submit')!;
const status = document.querySelector<HTMLElement>('#status')!;

const bridge = await waitForEvenAppBridge();
let settings = await loadSettings(bridge);
let app: GlassesApp | undefined;

function say(message: string, tone: 'ok' | 'error' | '' = '') {
  status.textContent = message;
  status.className = tone;
}

async function connect(config: Settings) {
  if (app) await app.stop();
  app = undefined;
  if (!config.url || !config.token) {
    await showSetupScreen(bridge);
    say(config.url ? 'Enter the pairing code to connect your glasses.' : '');
    return;
  }
  const next = new GlassesApp(bridge, new HttpBridgeApi(config.url, config.token));
  try {
    await new HttpBridgeApi(config.url, config.token).health();
    await next.start();
    app = next;
    say('Connected. Your threads are on your glasses.', 'ok');
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), 'error');
  }
}

url.value = settings.url;
token.value = settings.token;
code.addEventListener('input', () => {
  const digits = code.value.replace(/\D/g, '').slice(0, 6);
  code.value = digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  submit.disabled = true;
  try {
    const digits = code.value.replace(/\D/g, '');
    let nextToken = token.value.trim();
    if (digits.length === 6) {
      say('Pairing…');
      nextToken = await pairWithCode(url.value, digits);
    } else if (!nextToken) {
      throw new Error('Enter the 6-digit pairing code.');
    }
    settings = { url: url.value, token: nextToken };
    await saveSettings(bridge, settings);
    token.value = nextToken;
    code.value = '';
    await connect(await loadSettings(bridge));
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    submit.disabled = false;
  }
});

void connect(settings);
