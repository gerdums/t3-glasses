/** Speech-to-text for glasses microphone audio (16 kHz, signed 16-bit LE, mono). */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TranscriptionConfig } from "./config.js";

const run = promisify(execFile);
export const SAMPLE_RATE = 16_000;

export function pcmToWav(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function transcriptionAvailable(config: TranscriptionConfig): boolean {
  if (config.provider === "openai") return Boolean(process.env[config.apiKeyEnv ?? "OPENAI_API_KEY"]);
  if (config.provider === "whisper-server") return Boolean(config.url);
  return config.provider === "command" && config.command.length > 0;
}

export async function transcribe(pcm: Buffer, config: TranscriptionConfig): Promise<string> {
  if (pcm.length < SAMPLE_RATE / 5) return ""; // under 100 ms of audio
  const wav = pcmToWav(pcm);
  switch (config.provider) {
    case "openai": {
      const apiKey = process.env[config.apiKeyEnv ?? "OPENAI_API_KEY"];
      if (!apiKey) throw new Error(`Set ${config.apiKeyEnv ?? "OPENAI_API_KEY"} to enable transcription`);
      const form = new FormData();
      form.set("model", config.model ?? "whisper-1");
      form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
      const response = await fetch(`${config.baseUrl ?? "https://api.openai.com/v1"}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`Transcription failed (HTTP ${response.status})`);
      return ((await response.json()) as { text: string }).text.trim();
    }
    case "whisper-server": {
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
      form.set("response_format", "json");
      const response = await fetch(`${config.url.replace(/\/$/, "")}/inference`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(60_000),
      }).catch(() => {
        throw new Error("Voice transcription is not running. Run `t3-glasses setup` to install it.");
      });
      if (!response.ok) throw new Error(`Transcription failed (HTTP ${response.status})`);
      return ((await response.json()) as { text: string }).text.replace(/\s+/g, " ").trim();
    }
    case "command": {
      const dir = await mkdtemp(join(tmpdir(), "t3-glasses-"));
      try {
        const file = join(dir, "speech.wav");
        await writeFile(file, wav);
        const [bin, ...args] = config.command.map((part) => part.replaceAll("{wav}", file));
        const { stdout } = await run(bin!, args, { timeout: 120_000, maxBuffer: 1 << 20 });
        return stdout.replace(/\s+/g, " ").trim();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    default:
      throw new Error("Transcription is not configured. See `t3-glasses transcription --help`.");
  }
}
