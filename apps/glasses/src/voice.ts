import { AudioInputSource, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import type { BridgeApi } from './api';
export class VoiceCapture {
  private frames: Uint8Array[] = [];
  private active = false;
  constructor(private bridge: Pick<EvenAppBridge, 'audioControl'>, private api: Pick<BridgeApi, 'transcribe'>) {}
  async start() {
    this.frames = [];
    if (!await this.bridge.audioControl(true, AudioInputSource.Glasses)) throw new Error('Glasses microphone unavailable');
    this.active = true;
  }
  add(frame: Uint8Array) { if (this.active) this.frames.push(new Uint8Array(frame)); }
  async stop(): Promise<string> {
    if (!this.active) return '';
    this.active = false;
    await this.bridge.audioControl(false);
    const size = this.frames.reduce((total, frame) => total + frame.length, 0);
    if (!size) throw new Error('No speech captured');
    const pcm = new Uint8Array(size);
    let offset = 0;
    for (const frame of this.frames) { pcm.set(frame, offset); offset += frame.length; }
    this.frames = [];
    return (await this.api.transcribe(pcm)).text.trim();
  }
  async cancel() { this.active = false; this.frames = []; await this.bridge.audioControl(false); }
}
