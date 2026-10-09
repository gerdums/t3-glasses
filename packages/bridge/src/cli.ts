#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
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
import { exposeOnTailnet, installService, restartService, serviceLogPath, serviceStatus, uninstallService } from "./service.js";

const HELP = `t3-glasses: T3 Code threads on Even Realities G2 glasses

Usage:
  t3-glasses setup                  Sign in to your T3 account (one time) and show glasses pairing info
  t3-glasses setup --email <email>  Send a sign-in code (non-interactive step 1)
  t3-glasses setup --code <code>    Finish sign-in with the emailed code (step 2)
  t3-glasses serve [--host H] [--port P]
                                    Run the bridge
  t3-glasses status                 Show the account, environments, and glasses settings
  t3-glasses service install        Run the bridge at login and keep it running (macOS)
  t3-glasses service uninstall|restart|status
  t3-glasses expose                 Publish the bridge on your tailnet over HTTPS
  t3-glasses glasses-code           Show a 6-digit code to pair the glasses app
  t3-glasses token [--rotate]       Print (or replace) the glasses token
  t3-glasses pair <pairing link>    Add a machine that is not on T3 Connect
  t3-glasses unpair <id|label>      Remove a directly paired machine
  t3-glasses transcription openai [--model M] [--api-key-env VAR]
  t3-glasses transcription command -- <cmd> [args with {wav}]
  t3-glasses transcription none
  t3-glasses logout                 Sign out of the T3 account

Config: ${defaultConfigPath()} (override with T3_GLASSES_CONFIG)
`;

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function persist(config: BridgeConfig): Promise<void> {
  await saveConfig(config);
}

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
  console.log(`Sign-in code sent to ${email}.`);
}

async function finishCode(config: BridgeConfig, code: string, frontendApi: string): Promise<void> {
  const pending = config.account?.pendingSignInId;
  if (!pending) throw new Error("No sign-in in progress. Run `t3-glasses setup --email <email>` first.");
  const clerk = await ensureClerk(config, frontendApi);
  await clerk.completeEmailCode(pending, code);
  config.account = { ...config.account!, clerk: clerk.current, pendingSignInId: undefined };
  await persist(config);
  console.log("Signed in to T3.");
}

async function showEnvironments(config: BridgeConfig): Promise<void> {
  const account = accountFromConfig(config, persist);
  if (account) {
    try {
      const envs = await account.listEnvironments();
      console.log(`\nT3 Connect environments (${envs.length}):`);
      for (const env of envs) console.log(`  - ${env.label}  (${env.environmentId})`);
    } catch (error) {
      console.log(`\nCould not list T3 Connect environments: ${(error as Error).message}`);
    }
  } else {
    console.log("\nT3 account: not signed in");
  }
  if (config.environments.length > 0) {
    console.log(`\nDirectly paired (${config.environments.length}):`);
    for (const env of config.environments) {
      console.log(`  - ${env.label}  ${env.httpBaseUrl}  session expires ${env.expiresAt.slice(0, 10)}`);
    }
  }
}

async function showGlassesInfo(config: BridgeConfig): Promise<void> {
  const code = issueGlassesCode(config);
  await persist(config);
  console.log(`
Glasses app
  Bridge URL:    https://<this computer's tailnet name>:${config.port}  (t3-glasses expose prints it)
  Pairing code:  ${code.slice(0, 3)} ${code.slice(3)}   (valid 10 minutes; enter it in the glasses app on your phone)

Keep the bridge running with: t3-glasses service install`);
}

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
          "clerk-url": { type: "string", default: DEFAULT_CLERK_FRONTEND_API },
        },
      });
      const frontendApi = values["clerk-url"]!;
      if (values.email) {
        await sendCode(config, values.email, frontendApi);
        if (!values.code) {
          console.log("Finish with: t3-glasses setup --code <code>");
          return;
        }
      }
      if (values.code) {
        await finishCode(config, values.code, frontendApi);
      } else if (!config.account?.clerk.sessionId) {
        if (!process.stdin.isTTY) throw new Error("Not signed in. Use --email, then --code.");
        const email = await prompt("T3 account email: ");
        await sendCode(config, email, frontendApi);
        await finishCode(config, await prompt("Code from the email: "), frontendApi);
      } else {
        console.log("Already signed in to T3.");
      }
      await showEnvironments(config);
      await showGlassesInfo(config);
      return;
    }
    case "glasses-code": {
      const code = issueGlassesCode(config);
      await persist(config);
      console.log(`Pairing code: ${code.slice(0, 3)} ${code.slice(3)}  (valid 10 minutes)`);
      return;
    }
    case "serve": {
      const { values } = parseArgs({ args: rest, options: { host: { type: "string" }, port: { type: "string" } } });
      const bridge = await startBridge({
        host: values.host,
        port: values.port ? Number(values.port) : undefined,
      });
      const shutdown = () => void bridge.stop().then(() => process.exit(0));
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }
    case "status":
      await showEnvironments(config);
      if (process.platform === "darwin") console.log(`\nService: ${await serviceStatus()}`);
      return;
    case "service": {
      const action = rest[0];
      if (action === "install") {
        const path = await installService(fileURLToPath(import.meta.url));
        console.log(`Installed ${path}\nLogs: ${serviceLogPath()}`);
      } else if (action === "uninstall") {
        await uninstallService();
        console.log("Service removed.");
      } else if (action === "restart") {
        await restartService();
        console.log("Restarted.");
      } else if (action === "status") {
        console.log(await serviceStatus());
      } else {
        throw new Error("Usage: t3-glasses service <install|uninstall|restart|status>");
      }
      return;
    }
    case "expose": {
      const url = await exposeOnTailnet(config.port);
      console.log(`Bridge URL: ${url}`);
      return;
    }
    case "token": {
      const { values } = parseArgs({ args: rest, options: { rotate: { type: "boolean" } } });
      if (values.rotate) {
        config.glassesToken = newGlassesToken();
        await persist(config);
        console.log("New glasses token (restart the bridge and update the glasses app):");
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
      console.log(`Paired ${env.label} (${env.id}); session expires ${env.expiresAt.slice(0, 10)}.`);
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
        const clerk = new ClerkAuth(config.account.clerk);
        await clerk.signOut();
        config.account = undefined;
        await persist(config);
      }
      console.log("Signed out of T3.");
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
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
