import { hostname } from "node:os";
import type { EnvironmentConfig } from "./config.js";

const PAIRING_TOKEN_PARAM = "token";
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const BOOTSTRAP_TOKEN_TYPE = "urn:t3:params:oauth:token-type:environment-bootstrap";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
export const BRIDGE_SCOPES = "orchestration:read orchestration:operate";

export interface PairingTarget {
  httpBaseUrl: string;
  credential: string;
}

function readToken(url: URL): string | null {
  const hash = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const fromHash = hash.get(PAIRING_TOKEN_PARAM)?.trim();
  if (fromHash) return fromHash;
  return url.searchParams.get(PAIRING_TOKEN_PARAM)?.trim() || null;
}

/**
 * Accepts the links T3 Code produces:
 * - direct:  https://<env>/pair#token=<credential>
 * - hosted:  https://app.t3.codes/pair?host=<env url>#token=<credential>
 * - a bare `<env url>` plus a separate credential.
 */
export function parsePairingLink(link: string, credential?: string): PairingTarget {
  const url = new URL(link.trim());
  const token = credential?.trim() || readToken(url);
  if (!token) {
    throw new Error("The pairing link has no token. Copy the full link, including #token=...");
  }
  const hostParam = url.searchParams.get("host")?.trim();
  const base = hostParam ? new URL(hostParam) : new URL(url.origin);
  return { httpBaseUrl: base.origin, credential: token };
}

export interface EnvironmentDescriptor {
  environmentId: string;
  label: string;
  serverVersion?: string;
  orchestrationProtocolVersion?: number;
  capabilities?: Record<string, unknown>;
}

export async function fetchDescriptor(httpBaseUrl: string): Promise<EnvironmentDescriptor> {
  const response = await fetch(`${httpBaseUrl}/.well-known/t3/environment`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`${httpBaseUrl} is not a T3 Code environment (HTTP ${response.status})`);
  }
  return (await response.json()) as EnvironmentDescriptor;
}

export async function exchangePairingCredential(
  target: PairingTarget,
  label = `t3-glasses on ${hostname()}`,
): Promise<{ token: string; scopes: string; expiresAt: string }> {
  const body = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: target.credential,
    subject_token_type: BOOTSTRAP_TOKEN_TYPE,
    requested_token_type: ACCESS_TOKEN_TYPE,
    scope: BRIDGE_SCOPES,
    client_label: label,
    client_device_type: "bot",
  });
  const response = await fetch(`${target.httpBaseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Pairing failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }
  const result = JSON.parse(text) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
  };
  if (result.token_type !== "Bearer") {
    throw new Error(`Expected a Bearer session, got ${result.token_type}`);
  }
  return {
    token: result.access_token,
    scopes: result.scope,
    expiresAt: new Date(Date.now() + result.expires_in * 1000).toISOString(),
  };
}

export async function pairEnvironment(
  link: string,
  options: { credential?: string; label?: string; clientLabel?: string } = {},
): Promise<EnvironmentConfig> {
  const target = parsePairingLink(link, options.credential);
  const descriptor = await fetchDescriptor(target.httpBaseUrl);
  if (descriptor.orchestrationProtocolVersion !== undefined && descriptor.orchestrationProtocolVersion !== 2) {
    throw new Error(
      `Environment speaks orchestration protocol ${descriptor.orchestrationProtocolVersion}; t3-glasses supports 2`,
    );
  }
  const session = await exchangePairingCredential(target, options.clientLabel);
  return {
    id: descriptor.environmentId,
    label: options.label || descriptor.label,
    httpBaseUrl: target.httpBaseUrl,
    token: session.token,
    scopes: session.scopes,
    pairedAt: new Date().toISOString(),
    expiresAt: session.expiresAt,
  };
}
