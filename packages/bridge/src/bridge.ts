/** Wires config, account discovery, paired environments, and the HTTP server together. */
import type { Server } from "node:http";
import { ClerkAuth } from "./clerk.js";
import { loadConfig, readT3WorkingSection, redeemGlassesCode, saveConfig, type BridgeConfig } from "./config.js";
import { DpopSigner } from "./dpop.js";
import { BearerAuth, EnvironmentConnection } from "./environment.js";
import { Hub } from "./hub.js";
import { RelayAccount, RelayEnvironmentAuth } from "./relay.js";
import { createBridgeServer } from "./server.js";

const DISCOVERY_INTERVAL_MS = 60_000;

export function accountFromConfig(
  config: BridgeConfig,
  persist: (config: BridgeConfig) => Promise<void>,
): RelayAccount | null {
  const account = config.account;
  if (!account?.clerk.sessionId) return null;
  const clerk = new ClerkAuth(account.clerk, async (state) => {
    config.account = { ...account, clerk: state };
    await persist(config);
  });
  return new RelayAccount(clerk, new DpopSigner(account.dpopKey), account.relayUrl);
}

export interface RunningBridge {
  hub: Hub;
  server: Server;
  config: BridgeConfig;
  stop(): Promise<void>;
}

export async function startBridge(options: {
  configPath?: string;
  host?: string;
  port?: number;
  log?: (message: string) => void;
}): Promise<RunningBridge> {
  const log = options.log ?? ((message: string) => console.log(message));
  const config = await loadConfig(options.configPath);
  const persist = (next: BridgeConfig) => saveConfig(next, options.configPath);
  // Follow T3 desktop's Working beta unless the user chose explicitly; re-read so toggles carry over.
  let desktopWorking = await readT3WorkingSection();
  const workingTimer = setInterval(() => {
    void readT3WorkingSection().then((value) => {
      if (value === desktopWorking) return;
      desktopWorking = value;
      hub.emit("change");
    });
  }, 30_000);
  workingTimer.unref();
  const workingEnabled = () =>
    config.workingSection === "on" ? true : config.workingSection === "off" ? false : desktopWorking;
  const hub = new Hub(workingEnabled);

  for (const env of config.environments) {
    hub.add(new EnvironmentConnection(env, new BearerAuth(env.token)));
    log(`paired environment: ${env.label}`);
  }

  const account = accountFromConfig(config, persist);
  const accountEnvIds = new Set<string>();
  const discover = async () => {
    if (!account) return;
    try {
      const hidden = new Set(config.account?.hiddenEnvironments ?? []);
      const listed = (await account.listEnvironments()).filter((env) => !hidden.has(env.environmentId));
      const seen = new Set<string>();
      for (const env of listed) {
        seen.add(env.environmentId);
        // A directly paired session for the same machine wins.
        if (config.environments.some((paired) => paired.id === env.environmentId)) continue;
        if (accountEnvIds.has(env.environmentId)) continue;
        const auth = new RelayEnvironmentAuth(account, env.environmentId, env.endpoint.httpBaseUrl);
        hub.add(
          new EnvironmentConnection(
            { id: env.environmentId, label: env.label, httpBaseUrl: auth.httpBaseUrl },
            auth,
          ),
        );
        accountEnvIds.add(env.environmentId);
        log(`T3 Connect environment: ${env.label}`);
      }
      for (const id of [...accountEnvIds]) {
        if (seen.has(id)) continue;
        hub.remove(id);
        accountEnvIds.delete(id);
        log(`environment unlinked: ${id}`);
      }
    } catch (error) {
      log(`environment discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  await discover();
  const discoveryTimer = setInterval(() => void discover(), DISCOVERY_INTERVAL_MS);
  discoveryTimer.unref();

  if (!account && config.environments.length === 0) {
    log("No T3 account or paired environments yet. Run `t3-glasses setup`.");
  }

  const pairGlasses = async (code: string) => {
    // The CLI issues codes in another process, so read the file fresh.
    const onDisk = await loadConfig(options.configPath);
    const outcome = redeemGlassesCode(onDisk, code);
    await persist(onDisk);
    if (outcome === "ok") return { token: onDisk.glassesToken };
    return { error: outcome === "expired" ? "Code expired. Run `t3-glasses glasses-code` for a new one." : "Wrong code" };
  };
  const server = createBridgeServer(hub, () => config, pairGlasses);
  const host = options.host ?? config.host;
  const port = options.port ?? config.port;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  log(`t3-glasses bridge listening on http://${host}:${port}`);

  return {
    hub,
    server,
    config,
    async stop() {
      clearInterval(discoveryTimer);
      clearInterval(workingTimer);
      hub.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
