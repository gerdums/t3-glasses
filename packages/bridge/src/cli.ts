#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import qrcode from "qrcode-terminal";
import { accountFromConfig, startBridge } from "./bridge.js";
import { ClerkAuth, DEFAULT_CLERK_FRONTEND_API } from "./clerk.js";
import {
  defaultConfigPath,
  issueGlassesCode,
  loadConfig,
  newGlassesToken,
  removeEnvironment,
  saveConfig,
  upsertEnvironment,
  type BridgeConfig,
  type TranscriptionConfig,
} from "./config.js";
import { generateDpopKey } from "./dpop.js";
import { pairEnvironment } from "./pairing.js";
import { DEFAULT_RELAY_URL } from "./relay.js";
import {
  BRIDGE_LABEL,
  WHISPER_LABEL,
  WHISPER_PORT,
  agentStatus,
  bridgeAgent,
  exposeOnTailnet,
  installAgent,
  installWhisper,
  isMac,
  restartAgent,
  serviceLogPath,
  uninstallAgent,
  unexposeFromTailnet,
  whisperAgent,
} from "./service.js";

const CLI_PATH = fileURLToPath(import.meta.url);

const HELP = `t3-glasses: T3 Code threads on Even Realities G2 glasses

Get started:
  t3-glasses setup                  Sign in, publish on your tailnet, start the services,
                                    and show a QR code for your glasses. Safe to re-run.

Everyday:
  t3-glasses status                 Account, computers, services, and the bridge address
  t3-glasses glasses-code           Show a fresh pairing QR code and 6-digit code

Services (macOS login agents, installed by setup):
  t3-glasses service install|uninstall|restart|status

More:
  t3-glasses setup --email <email>  Non-interactive sign-in, step 1 (sends a code)
  t3-glasses setup --code <code>    Non-interactive sign-in, step 2
  t3-glasses setup --no-voice       Skip local voice transcription
  t3-glasses serve [--host H] [--port P]   Run the bridge in the foreground
  t3-glasses expose                 Publish the bridge on your tailnet over HTTPS
  t3-glasses transcription openai [--model M] [--api-key-env VAR] | command -- <cmd> | none
  t3-glasses pair <pairing link>    Add a computer that is not on T3 Connect
  t3-glasses unpair <id|label>
  t3-glasses token [--rotate]       Print or replace the glasses token
  t3-glasses logout                 Sign out of T3
  t3-glasses uninstall              Stop the services, unpublish, sign out, and remove settings

Config: ${defaultConfigPath()} (override with T3_GLASSES_CONFIG)
`;

// ---- Output ---------------------------------------------------------------------

const tty = process.stdout.isTTY;
const bold = (text: string) => (tty ? `\x1b[1m${text}\x1b[22m` : text);
const dim = (text: string) => (tty ? `\x1b[2m${text}\x1b[22m` : text);
const green = (text: string) => (tty ? `\x1b[32m${text}\x1b[39m` : text);
const step = (n: number, total: number, title: string) => console.log(`\n${bold(`${n}/${total}  ${title}`)}`);
const ok = (text: string) => console.log(`    ${green("✓")} ${text}`);
const note = (text: string) => console.log(`    ${dim(text)}`);

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function confirm(question: string, fallback = true): Promise<boolean> {
  if (!process.stdin.isTTY) return fallback;
  const answer = (await prompt(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  return answer ? answer.startsWith("y") : fallback;
}

async function persist(config: BridgeConfig): Promise<void> {
  await saveConfig(config);
}

// ---- T3 sign-in -----------------------------------------------------------------

async function ensureClerk(config: BridgeConfig, frontendApi: string): Promise<ClerkAuth> {
  if (!config.account) {
    const clerk = await ClerkAuth.createClient(frontendApi);
    config.account = { clerk: clerk.current, dpopKey: generateDpopKey(), relayUrl: DEFAULT_RELAY_URL };
    await persist(config);
  }
  const account = config.account;
  return new ClerkAuth(account.clerk, async (state) => {
    config.account = { ...account, ...config.account, clerk: state };
    await persist(config);
  });
}

async function sendCode(config: BridgeConfig, email: string, frontendApi: string): Promise<void> {
  const clerk = await ensureClerk(config, frontendApi);
  const signInId = await clerk.startEmailCode(email);
  config.account = { ...config.account!, clerk: clerk.current, pendingSignInId: signInId };
  await persist(config);
  ok(`Sign-in code sent to ${email}`);
}

async function finishCode(config: BridgeConfig, code: string, frontendApi: string): Promise<void> {
  const pending = config.account?.pendingSignInId;
  if (!pending) throw new Error("No sign-in in progress. Run `t3-glasses setup --email <email>` first.");
  const clerk = await ensureClerk(config, frontendApi);
  await clerk.completeEmailCode(pending, code);
  config.account = { ...config.account!, clerk: clerk.current, pendingSignInId: undefined };
  await persist(config);
  ok("Signed in to T3");
}

async function listComputers(config: BridgeConfig): Promise<number> {
  const account = accountFromConfig(config, persist);
  let count = config.environments.length;
  if (account) {
    const envs = await account.listEnvironments();
    count += envs.length;
    for (const env of envs) ok(env.label);
  }
  for (const env of config.environments) ok(`${env.label} ${dim("(paired directly)")}`);
  return count;
}

// ---- Glasses pairing -------------------------------------------------------------

async function showPairing(config: BridgeConfig): Promise<void> {
  const code = issueGlassesCode(config);
  await persist(config);
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  if (config.bridgeUrl) {
    const link = `${config.bridgeUrl}/#code=${code}`;
    console.log(`\n${bold("Pair your glasses")}  ${dim("(code valid for 10 minutes)")}\n`);
    console.log("  1. In the Even app, turn on Developer Mode (Hardware tab, Developer Mode).");
    console.log("  2. Open the Even Hub tab, tap Scan QR, and scan this code:\n");
    qrcode.generate(link, { small: true }, (art) => console.log(art.replace(/^/gm, "     ")));
    console.log(`  ${dim("Or open")} ${link}`);
    console.log(`  ${dim("Or type the code")} ${bold(spaced)} ${dim("in T3 Glasses on your phone.")}`);
    console.log(`\n  ${dim("Your phone needs Tailscale turned on, signed in to the same account.")}`);
  } else {
    console.log(`\nPairing code: ${bold(spaced)} ${dim("(valid 10 minutes)")}`);
  }
}

// ---- Setup ----------------------------------------------------------------------

async function setup(config: BridgeConfig, values: { email?: string; code?: string; "clerk-url"?: string; voice?: boolean }) {
  const frontendApi = values["clerk-url"] ?? DEFAULT_CLERK_FRONTEND_API;

  // Non-interactive sign-in steps for scripts.
  if (values.email) {
    await sendCode(config, values.email, frontendApi);
    if (!values.code) {
      console.log("Finish with: t3-glasses setup --code <code>");
      return;
    }
  }
  if (values.code) await finishCode(config, values.code, frontendApi);

  const total = isMac() ? 5 : 3;
  console.log(bold("\nT3 Glasses setup"));

  step(1, total, "Sign in to T3");
  if (config.account?.clerk.sessionId) {
    ok("Already signed in");
  } else {
    if (!process.stdin.isTTY) throw new Error("Not signed in. Run `t3-glasses setup` in a terminal, or use --email then --code.");
    note("Use the email on your T3 account (GitHub sign-ins work too).");
    const email = await prompt("    Email: ");
    await sendCode(config, email, frontendApi);
    await finishCode(config, await prompt("    Code from the email: "), frontendApi);
  }

  step(2, total, "Find your computers");
  const computers = await listComputers(config);
  if (computers === 0) note("None yet. Link your computers to T3 Connect in T3 Code's settings; they'll appear automatically.");

  step(3, total, "Publish the bridge on your tailnet");
  try {
    config.bridgeUrl = await exposeOnTailnet(config.port);
    await persist(config);
    ok(config.bridgeUrl);
  } catch (error) {
    console.log(`    ${(error as Error).message}`);
    throw new Error("Setup needs Tailscale. Fix the above and run `t3-glasses setup` again; finished steps are skipped.");
  }

  if (isMac()) {
    step(4, total, "Voice replies");
    if (values.voice === false) {
      note("Skipped (--no-voice)");
    } else if (config.transcription.provider !== "none" && config.transcription.provider !== "whisper-server") {
      ok(`Using ${config.transcription.provider}`);
    } else if (await confirm("    Install local speech-to-text with whisper.cpp (about 150 MB)?")) {
      const { server, model } = await installWhisper(note);
      await installAgent(whisperAgent(server, model));
      config.transcription = { provider: "whisper-server", url: `http://127.0.0.1:${WHISPER_PORT}` };
      await persist(config);
      ok("Running locally; audio never leaves this computer");
    } else {
      note("Skipped. The glasses work without it; voice replies stay off.");
    }

    step(5, total, "Start the bridge");
    await installAgent(bridgeAgent(CLI_PATH));
    ok(`Runs at login and restarts if it stops ${dim(`(log: ${serviceLogPath()})`)}`);
  } else {
    note("Run `t3-glasses serve` under your own supervisor (systemd, pm2, ...).");
  }

  await showPairing(config);
}

async function status(config: BridgeConfig): Promise<void> {
  console.log(bold("Account"));
  if (config.account?.clerk.sessionId) ok("Signed in to T3");
  else note("Not signed in. Run `t3-glasses setup`.");
  console.log(bold("\nComputers"));
  try {
    await listComputers(config);
  } catch (error) {
    note(`Could not list computers: ${(error as Error).message}`);
  }
  console.log(bold("\nBridge"));
  console.log(`    ${config.bridgeUrl ?? "not published yet (run t3-glasses setup)"}`);
  if (isMac()) {
    console.log(`    bridge service: ${await agentStatus(BRIDGE_LABEL)}`);
    console.log(`    voice service:  ${await agentStatus(WHISPER_LABEL)}`);
  }
  console.log(`    transcription:  ${config.transcription.provider}`);
}

// ---- Commands -------------------------------------------------------------------

async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);
  const config = await loadConfig();

  switch (command) {
    case "setup": {
      const { values } = parseArgs({
        args: rest,
        options: {
          email: { type: "string" },
          code: { type: "string" },
          "clerk-url": { type: "string" },
          "no-voice": { type: "boolean" },
        },
      });
      await setup(config, { ...values, voice: values["no-voice"] ? false : undefined });
      return;
    }
    case "status":
      await status(config);
      return;
    case "glasses-code":
      await showPairing(config);
      return;
    case "serve": {
      const { values } = parseArgs({ args: rest, options: { host: { type: "string" }, port: { type: "string" } } });
      const bridge = await startBridge({ host: values.host, port: values.port ? Number(values.port) : undefined });
      const shutdown = () => void bridge.stop().then(() => process.exit(0));
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }
    case "service": {
      const action = rest[0];
      if (action === "install") {
        await installAgent(bridgeAgent(CLI_PATH));
        console.log(`Installed. Log: ${serviceLogPath()}`);
      } else if (action === "uninstall") {
        await uninstallAgent(BRIDGE_LABEL);
        await uninstallAgent(WHISPER_LABEL);
        console.log("Services removed.");
      } else if (action === "restart") {
        await restartAgent(BRIDGE_LABEL);
        if ((await agentStatus(WHISPER_LABEL)) !== "not installed") await restartAgent(WHISPER_LABEL);
        console.log("Restarted.");
      } else if (action === "status") {
        console.log(`bridge: ${await agentStatus(BRIDGE_LABEL)}\nvoice:  ${await agentStatus(WHISPER_LABEL)}`);
      } else {
        throw new Error("Usage: t3-glasses service <install|uninstall|restart|status>");
      }
      return;
    }
    case "expose": {
      config.bridgeUrl = await exposeOnTailnet(config.port);
      await persist(config);
      console.log(`Bridge URL: ${config.bridgeUrl}`);
      return;
    }
    case "token": {
      const { values } = parseArgs({ args: rest, options: { rotate: { type: "boolean" } } });
      if (values.rotate) {
        config.glassesToken = newGlassesToken();
        await persist(config);
        console.log("New glasses token (re-pair the glasses with `t3-glasses glasses-code`):");
      }
      console.log(config.glassesToken);
      return;
    }
    case "pair": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { label: { type: "string" }, credential: { type: "string" } },
      });
      if (!positionals[0]) throw new Error("Usage: t3-glasses pair <pairing link>");
      const env = await pairEnvironment(positionals[0], { credential: values.credential, label: values.label });
      await persist(upsertEnvironment(config, env));
      console.log(`Paired ${env.label}; session expires ${env.expiresAt.slice(0, 10)}. Restart with: t3-glasses service restart`);
      return;
    }
    case "unpair": {
      if (!rest[0]) throw new Error("Usage: t3-glasses unpair <id|label>");
      await persist(removeEnvironment(config, rest[0]));
      console.log("Removed.");
      return;
    }
    case "transcription": {
      const [provider, ...args] = rest;
      let next: TranscriptionConfig;
      if (provider === "openai") {
        const { values } = parseArgs({ args, options: { model: { type: "string" }, "api-key-env": { type: "string" } } });
        next = {
          provider: "openai",
          ...(values.model ? { model: values.model } : {}),
          ...(values["api-key-env"] ? { apiKeyEnv: values["api-key-env"] } : {}),
        };
      } else if (provider === "command") {
        const command = args[0] === "--" ? args.slice(1) : args;
        if (command.length === 0) throw new Error("Usage: t3-glasses transcription command -- <cmd> [args with {wav}]");
        next = { provider: "command", command };
      } else if (provider === "none") {
        next = { provider: "none" };
      } else {
        throw new Error("Usage: t3-glasses transcription <openai|command|none>");
      }
      config.transcription = next;
      await persist(config);
      console.log(`Transcription: ${next.provider}`);
      return;
    }
    case "logout": {
      if (config.account) {
        await new ClerkAuth(config.account.clerk).signOut();
        config.account = undefined;
        await persist(config);
      }
      console.log("Signed out of T3.");
      return;
    }
    case "uninstall": {
      if (!(await confirm("Remove the services, tailnet address, T3 sign-in, and settings?", false))) return;
      if (isMac()) {
        await uninstallAgent(BRIDGE_LABEL);
        await uninstallAgent(WHISPER_LABEL);
      }
      await unexposeFromTailnet(config.port).catch(() => {});
      if (config.account) await new ClerkAuth(config.account.clerk).signOut().catch(() => {});
      await rm(defaultConfigPath(), { force: true });
      console.log("Removed. Delete the app with: rm -rf ~/.t3-glasses \"$(brew --prefix)/bin/t3-glasses\"");
      return;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      throw new Error(`Unknown command ${command}\n\n${HELP}`);
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
