/**
 * macOS login agents: the bridge, and optionally whisper-server for fast
 * local voice transcription. Both start at login and restart if they exit.
 */
import { execFile } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface AgentSpec {
  label: string;
  program: string[];
  env?: Record<string, string>;
  log: string;
}

export const BRIDGE_LABEL = "io.github.gerdums.t3-glasses";
export const WHISPER_LABEL = "io.github.gerdums.t3-glasses.whisper";
export const WHISPER_PORT = 4418;

const logsDir = () => join(homedir(), "Library", "Logs");
export const serviceLogPath = () => join(logsDir(), "t3-glasses.log");
const plistPath = (label: string) => join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const domain = () => `gui/${process.getuid?.() ?? 501}`;

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchAgentPlist(spec: AgentSpec): string {
  const args = spec.program.map((arg) => `      <string>${escape(arg)}</string>`).join("\n");
  const env = Object.entries(spec.env ?? {})
    .map(([key, value]) => `      <key>${escape(key)}</key><string>${escape(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${escape(spec.label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>${escape(spec.log)}</string>
    <key>StandardErrorPath</key><string>${escape(spec.log)}</string>
  </dict>
</plist>
`;
}

export function isMac(): boolean {
  return process.platform === "darwin";
}

function requireMac(): void {
  if (!isMac()) throw new Error("Login agents need macOS. Run `t3-glasses serve` under your own supervisor.");
}

async function isLoaded(label: string): Promise<boolean> {
  return run("launchctl", ["print", `${domain()}/${label}`]).then(
    () => true,
    () => false,
  );
}

export async function installAgent(spec: AgentSpec): Promise<string> {
  requireMac();
  const path = plistPath(spec.label);
  await mkdir(dirname(path), { recursive: true });
  await mkdir(logsDir(), { recursive: true });
  await writeFile(path, launchAgentPlist(spec), { mode: 0o600 });
  await run("launchctl", ["bootout", `${domain()}/${spec.label}`]).catch(() => {});
  // bootout returns before the old job is gone; bootstrap fails until it is.
  for (let attempt = 0; attempt < 50 && (await isLoaded(spec.label)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await run("launchctl", ["bootstrap", domain(), path]);
  return path;
}

export async function uninstallAgent(label: string): Promise<void> {
  requireMac();
  await run("launchctl", ["bootout", `${domain()}/${label}`]).catch(() => {});
  await rm(plistPath(label), { force: true });
}

export async function restartAgent(label: string): Promise<void> {
  requireMac();
  await run("launchctl", ["kickstart", "-k", `${domain()}/${label}`]);
}

export async function agentStatus(label: string): Promise<string> {
  if (!isMac()) return "unsupported";
  try {
    const { stdout } = await run("launchctl", ["print", `${domain()}/${label}`]);
    const state = /state = (\w+)/.exec(stdout)?.[1] ?? "unknown";
    const pid = /pid = (\d+)/.exec(stdout)?.[1];
    return `${state}${pid ? ` (pid ${pid})` : ""}`;
  } catch {
    return "not installed";
  }
}

export function bridgeAgent(cliPath: string): AgentSpec {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  for (const key of ["T3_GLASSES_CONFIG", "OPENAI_API_KEY"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return { label: BRIDGE_LABEL, program: [process.execPath, cliPath, "serve"], env, log: serviceLogPath() };
}

export function whisperAgent(binary: string, model: string): AgentSpec {
  return {
    label: WHISPER_LABEL,
    program: [binary, "-m", model, "--host", "127.0.0.1", "--port", String(WHISPER_PORT)],
    log: join(logsDir(), "t3-glasses-whisper.log"),
  };
}

// ---- Tools ----------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Finds an executable on PATH or in common install locations. */
export async function findTool(name: string, extra: string[] = []): Promise<string | null> {
  const dirs = [...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const candidate of [...dirs.map((dir) => join(dir, name)), ...extra]) {
    if (candidate && (await exists(candidate))) return candidate;
  }
  return null;
}

export const findTailscale = () => findTool("tailscale", ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);

/** Publishes the bridge on the tailnet over HTTPS with Tailscale Serve. */
export async function exposeOnTailnet(port: number): Promise<string> {
  const bin = await findTailscale();
  if (!bin) throw new Error("Tailscale is not installed. Install it from https://tailscale.com/download and sign in.");
  const { stdout } = await run(bin, ["status", "--json"]);
  const status = JSON.parse(stdout) as { BackendState?: string; Self?: { DNSName?: string } };
  if (status.BackendState !== "Running" || !status.Self?.DNSName) {
    throw new Error("Tailscale is installed but not connected. Open Tailscale and sign in, then run setup again.");
  }
  await run(bin, ["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`]);
  return `https://${status.Self.DNSName.replace(/\.$/, "")}:${port}`;
}

export async function unexposeFromTailnet(port: number): Promise<void> {
  const bin = await findTailscale();
  if (bin) await run(bin, ["serve", `--https=${port}`, "off"]);
}

export const WHISPER_MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
export const whisperModelPath = () => join(homedir(), ".local", "share", "t3-glasses", "models", "ggml-base.en.bin");

/** Installs whisper.cpp with Homebrew and downloads the English base model. */
export async function installWhisper(log: (message: string) => void): Promise<{ server: string; model: string }> {
  let server = await findTool("whisper-server");
  if (!server) {
    const brew = await findTool("brew");
    if (!brew) throw new Error("Homebrew is needed to install voice transcription: https://brew.sh");
    log("Installing whisper.cpp with Homebrew...");
    await run(brew, ["install", "whisper-cpp"], { maxBuffer: 1 << 24 });
    server = await findTool("whisper-server");
    if (!server) throw new Error("whisper-cpp installed, but whisper-server was not found");
  }
  const model = whisperModelPath();
  if (!(await exists(model))) {
    log("Downloading the speech model (150 MB)...");
    await mkdir(dirname(model), { recursive: true });
    const response = await fetch(WHISPER_MODEL_URL);
    if (!response.ok || !response.body) throw new Error(`Model download failed (HTTP ${response.status})`);
    const partial = `${model}.partial`;
    await writeFile(partial, Buffer.from(await response.arrayBuffer()));
    await run("mv", [partial, model]);
  }
  return { server, model };
}
