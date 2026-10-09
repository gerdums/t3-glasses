/**
 * T3 Connect account access: lists every environment linked to the signed-in
 * T3 account and authenticates to each one through the relay, the way T3's own
 * phone and web apps do.
 *
 * Chain: Clerk session JWT -> relay DPoP access token (30 min)
 *        -> per-environment bootstrap credential (2 min, single use)
 *        -> environment DPoP session (1 h). No refresh tokens; repeat the chain.
 */
import { hostname } from "node:os";
import type { ClerkAuth } from "./clerk.js";
import type { DpopSigner } from "./dpop.js";
import type { EnvironmentAuth } from "./environment.js";

export const DEFAULT_RELAY_URL = "https://relay.t3.codes";
/** T3's public web client id; the relay accepts only its first-party client ids. */
const RELAY_CLIENT_ID = "t3-web";
const RELAY_SCOPES = "environment:connect environment:status";
/** Least privilege for the glasses: no terminal, filesystem, or settings access. */
const ENVIRONMENT_SCOPES = "orchestration:read orchestration:operate";
const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const RENEW_EARLY_MS = 60_000;

export interface RelayEnvironment {
  environmentId: string;
  label: string;
  endpoint: { httpBaseUrl: string; wsBaseUrl?: string; providerKind?: string };
  linkedAt: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, 300);
}

export class RelayAccount {
  private relayToken: CachedToken | null = null;

  constructor(
    private readonly clerk: ClerkAuth,
    readonly signer: DpopSigner,
    readonly relayUrl = DEFAULT_RELAY_URL,
  ) {}

  async listEnvironments(): Promise<RelayEnvironment[]> {
    const response = await fetch(`${this.relayUrl}/v1/environments`, {
      headers: { authorization: `Bearer ${await this.clerk.relayToken()}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new RelayError(`Listing T3 environments failed (HTTP ${response.status}): ${await readError(response)}`, response.status);
    }
    const body = (await response.json()) as { environments: RelayEnvironment[] };
    return body.environments;
  }

  /** Returns a single-use bootstrap credential for one environment. */
  async connectEnvironment(environmentId: string): Promise<{ httpBaseUrl: string; credential: string }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const accessToken = await this.relayAccessToken();
      const url = `${this.relayUrl}/v1/environments/${encodeURIComponent(environmentId)}/connect`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `DPoP ${accessToken}`,
          dpop: this.signer.proof({ method: "POST", url, accessToken }),
          "content-type": "application/json",
        },
        body: JSON.stringify({ clientProofKeyThumbprint: this.signer.thumbprint }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 401 && attempt === 0) {
        this.relayToken = null;
        continue;
      }
      if (!response.ok) {
        throw new RelayError(`Connecting to environment failed (HTTP ${response.status}): ${await readError(response)}`, response.status);
      }
      const body = (await response.json()) as { endpoint: { httpBaseUrl: string }; credential: string };
      return { httpBaseUrl: body.endpoint.httpBaseUrl.replace(/\/+$/, ""), credential: body.credential };
    }
    throw new RelayError("Connecting to environment failed: not authorized", 401);
  }

  private async relayAccessToken(): Promise<string> {
    if (this.relayToken && this.relayToken.expiresAt - Date.now() > 5_000) return this.relayToken.token;
    const url = `${this.relayUrl}/v1/client/dpop-token`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        dpop: this.signer.proof({ method: "POST", url }),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE,
        subject_token: await this.clerk.relayToken(),
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        requested_token_type: ACCESS_TOKEN_TYPE,
        resource: new URL(this.relayUrl).origin,
        scope: RELAY_SCOPES,
        client_id: RELAY_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new RelayError(`T3 relay sign-in failed (HTTP ${response.status}): ${await readError(response)}`, response.status);
    }
    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.relayToken = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }
}

/** DPoP session for one environment, minted through the relay and renewed on demand. */
export class RelayEnvironmentAuth implements EnvironmentAuth {
  private session: CachedToken | null = null;
  private pending: Promise<CachedToken> | null = null;
  httpBaseUrl: string;

  constructor(
    private readonly account: RelayAccount,
    readonly environmentId: string,
    httpBaseUrl: string,
  ) {
    this.httpBaseUrl = httpBaseUrl.replace(/\/+$/, "");
  }

  async headers(method: string, url: string): Promise<Record<string, string>> {
    const session = await this.ensureSession();
    return {
      authorization: `DPoP ${session.token}`,
      dpop: this.account.signer.proof({ method, url, accessToken: session.token }),
    };
  }

  invalidate(): void {
    this.session = null;
  }

  private ensureSession(): Promise<CachedToken> {
    if (this.session && this.session.expiresAt - Date.now() > RENEW_EARLY_MS) return Promise.resolve(this.session);
    this.pending ??= this.bootstrap().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async bootstrap(): Promise<CachedToken> {
    const { httpBaseUrl, credential } = await this.account.connectEnvironment(this.environmentId);
    this.httpBaseUrl = httpBaseUrl;
    const url = `${httpBaseUrl}/oauth/token`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        dpop: this.account.signer.proof({ method: "POST", url }),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE,
        subject_token: credential,
        subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
        requested_token_type: ACCESS_TOKEN_TYPE,
        scope: ENVIRONMENT_SCOPES,
        client_label: `t3-glasses on ${hostname()}`,
        client_device_type: "bot",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new RelayError(`Environment sign-in failed (HTTP ${response.status}): ${await readError(response)}`, response.status);
    }
    const body = (await response.json()) as { access_token: string; token_type: string; expires_in: number };
    if (body.token_type !== "DPoP") throw new RelayError(`Expected a DPoP session, got ${body.token_type}`);
    this.session = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.session;
  }
}
