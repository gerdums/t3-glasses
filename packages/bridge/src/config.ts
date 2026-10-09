import { createHash, randomInt, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ClerkClientState } from "./clerk.js";
import type { DpopKeyMaterial } from "./dpop.js";

export interface EnvironmentConfig {
  /** T3 environment id from /.well-known/t3/environment. */
  id: string;
  label: string;
  /** Base URL the bridge reaches the environment at, without a trailing slash. */
  httpBaseUrl: string;
  /** Bearer session token. Secret. */
  token: string;
  scopes: string;
  pairedAt: string;
  expiresAt: string;
}

export type TranscriptionConfig =
  | { provider: "none" }
  /** OpenAI-compatible /v1/audio/transcriptions endpoint. */
  | {
      provider: "openai";
      model?: string;
      baseUrl?: string;
      /** Environment variable that holds the API key. Default OPENAI_API_KEY. */
      apiKeyEnv?: string;
    }
  /**
   * Local command. `{wav}` in any argument is replaced with the path to a
   * 16 kHz mono WAV file; the command prints the transcript on stdout.
   * Example: ["whisper-cli", "-m", "/models/ggml-base.en.bin", "-nt", "-np", "-f", "{wav}"]
   */
  | { provider: "command"; command: string[] }
  /** whisper.cpp's whisper-server, kept warm by a login agent. */
  | { provider: "whisper-server"; url: string };

/** T3 account sign-in: discovers every environment linked through T3 Connect. */
export interface AccountConfig {
  clerk: ClerkClientState;
  /** DPoP key the relay binds sessions to. Secret. */
  dpopKey: DpopKeyMaterial;
  relayUrl?: string;
  /** Email-code sign-in waiting for its code. */
  pendingSignInId?: string;
  /** Environment ids to hide from the glasses. */
  hiddenEnvironments?: string[];
}

/** A short-lived code the glasses app exchanges for the glasses token. */
export interface GlassesPairing {
  /** SHA-256 of the code, hex. */
  codeHash: string;
  expiresAt: string;
  attempts: number;
}

export interface BridgeConfig {
  version: 1;
  glassesPairing?: GlassesPairing;
  /** Public HTTPS address of this bridge (set by `t3-glasses expose`). */
  bridgeUrl?: string;
  account?: AccountConfig;
  /** Token the glasses app presents to the bridge. Secret. */
  glassesToken: string;
  host: string;
  port: number;
  /** Extra origins allowed by CORS besides the Even app WebView. "*" allows any. */
  allowedOrigins: string[];
  /** Environments paired directly (fallback for machines not on T3 Connect). */
  environments: EnvironmentConfig[];
  transcription: TranscriptionConfig;
}

export function defaultConfigPath(): string {
  const explicit = process.env.T3_GLASSES_CONFIG;
  if (explicit) return explicit;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "t3-glasses", "config.json");
}

export function newGlassesToken(): string {
  return randomBytes(24).toString("base64url");
}

export function defaultConfig(): BridgeConfig {
  return {
    version: 1,
    glassesToken: newGlassesToken(),
    host: "127.0.0.1",
    port: 4417,
    allowedOrigins: ["*"],
    environments: [],
    transcription: { provider: "none" },
  };
}

export async function loadConfig(path = defaultConfigPath()): Promise<BridgeConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const config = defaultConfig();
      await saveConfig(config, path);
      return config;
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<BridgeConfig>;
  return { ...defaultConfig(), ...parsed, version: 1 };
}

/** Writes atomically with owner-only permissions; the file holds secrets. */
export async function saveConfig(config: BridgeConfig, path = defaultConfigPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

export function upsertEnvironment(config: BridgeConfig, env: EnvironmentConfig): BridgeConfig {
  const others = config.environments.filter((existing) => existing.id !== env.id);
  return { ...config, environments: [...others, env] };
}

export function removeEnvironment(config: BridgeConfig, idOrLabel: string): BridgeConfig {
  const needle = idOrLabel.toLowerCase();
  return {
    ...config,
    environments: config.environments.filter(
      (env) => env.id !== idOrLabel && env.label.toLowerCase() !== needle,
    ),
  };
}

export const GLASSES_CODE_TTL_MS = 10 * 60_000;
export const GLASSES_CODE_ATTEMPTS = 5;

const hashCode = (code: string) => createHash("sha256").update(code.replace(/\D/g, "")).digest("hex");

/** Issues a 6-digit code; returns it once and stores only its hash. */
export function issueGlassesCode(config: BridgeConfig, now = Date.now()): string {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  config.glassesPairing = {
    codeHash: hashCode(code),
    expiresAt: new Date(now + GLASSES_CODE_TTL_MS).toISOString(),
    attempts: 0,
  };
  return code;
}

/** Checks a code; consumes it on success and counts failures against it. */
export function redeemGlassesCode(config: BridgeConfig, code: string, now = Date.now()): "ok" | "invalid" | "expired" {
  const pairing = config.glassesPairing;
  if (!pairing || Date.parse(pairing.expiresAt) < now || pairing.attempts >= GLASSES_CODE_ATTEMPTS) {
    config.glassesPairing = undefined;
    return "expired";
  }
  if (hashCode(code) !== pairing.codeHash) {
    pairing.attempts += 1;
    return "invalid";
  }
  config.glassesPairing = undefined;
  return "ok";
}
