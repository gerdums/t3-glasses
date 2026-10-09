/** Runs the bridge as a macOS login agent so it is always available. */
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const SERVICE_LABEL = "io.github.gerdums.t3-glasses";

const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
export const serviceLogPath = () => join(homedir(), "Library", "Logs", "t3-glasses.log");

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchAgentPlist(nodePath: string, cliPath: string, env: Record<string, string>): string {
  const envEntries = Object.entries(env)
    .map(([key, value]) => `      <key>${escape(key)}</key><string>${escape(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escape(nodePath)}</string>
      <string>${escape(cliPath)}</string>
      <string>serve</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>${escape(serviceLogPath())}</string>
    <key>StandardErrorPath</key><string>${escape(serviceLogPath())}</string>
  </dict>
</plist>
`;
}

function requireMac(): void {
  if (process.platform !== "darwin") throw new Error("The service command supports macOS. Run `t3-glasses serve` under your own supervisor.");
}

export async function installService(cliPath: string): Promise<string> {
  requireMac();
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  for (const key of ["T3_GLASSES_CONFIG", "OPENAI_API_KEY"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  const path = plistPath();
  await mkdir(dirname(path), { recursive: true });
  await mkdir(dirname(serviceLogPath()), { recursive: true });
  await writeFile(path, launchAgentPlist(process.execPath, cliPath, env), { mode: 0o600 });
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await run("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]).catch(() => {});
  // bootout returns before the old job is gone; bootstrap fails until it is.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const loaded = await run("launchctl", ["print", `${domain}/${SERVICE_LABEL}`]).then(() => true, () => false);
    if (!loaded) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await run("launchctl", ["bootstrap", domain, path]);
  return path;
}

export async function restartService(): Promise<void> {
  requireMac();
  await run("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${SERVICE_LABEL}`]);
}

export async function uninstallService(): Promise<void> {
  requireMac();
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await run("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]).catch(() => {});
  await rm(plistPath(), { force: true });
}

export async function serviceStatus(): Promise<string> {
  requireMac();
  const domain = `gui/${process.getuid?.() ?? 501}`;
  try {
    const { stdout } = await run("launchctl", ["print", `${domain}/${SERVICE_LABEL}`]);
    const state = /state = (\w+)/.exec(stdout)?.[1] ?? "unknown";
    const pid = /pid = (\d+)/.exec(stdout)?.[1];
    return `${state}${pid ? ` (pid ${pid})` : ""}`;
  } catch {
    return "not installed";
  }
}

/** Publishes the bridge on the tailnet over HTTPS with Tailscale Serve. */
export async function exposeOnTailnet(port: number): Promise<string> {
  const candidates = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
  for (const bin of candidates) {
    try {
      await run(bin, ["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`]);
      const { stdout } = await run(bin, ["status", "--json"]);
      const dns = (JSON.parse(stdout) as { Self: { DNSName: string } }).Self.DNSName.replace(/\.$/, "");
      return `https://${dns}:${port}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  throw new Error("Tailscale is not installed. Install it, or put the bridge behind your own HTTPS proxy.");
}
