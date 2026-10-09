/**
 * DPoP (RFC 9449) proofs with an ES256 key, as required by the T3 relay and by
 * environment sessions minted through it.
 */
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";

export interface PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export interface DpopKeyMaterial {
  /** PKCS#8 PEM. Secret. */
  privateKeyPem: string;
  publicJwk: PublicJwk;
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

export function generateDpopKey(): DpopKeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string; y: string };
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
  };
}

/** RFC 7638 JWK thumbprint (SHA-256, base64url). */
export function jwkThumbprint(jwk: PublicJwk): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash("sha256").update(canonical).digest("base64url");
}

/** htu is the request URL without query or fragment. */
export function dpopHtu(url: string | URL): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

export function accessTokenHash(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("base64url");
}

export class DpopSigner {
  private readonly key: KeyObject;
  readonly thumbprint: string;

  constructor(readonly material: DpopKeyMaterial) {
    this.key = createPrivateKey(material.privateKeyPem);
    this.thumbprint = jwkThumbprint(material.publicJwk);
  }

  proof(input: { method: string; url: string | URL; accessToken?: string; nonce?: string }): string {
    const header = { typ: "dpop+jwt", alg: "ES256", jwk: this.material.publicJwk };
    const payload: Record<string, unknown> = {
      jti: randomUUID(),
      htm: input.method.toUpperCase(),
      htu: dpopHtu(input.url),
      iat: Math.floor(Date.now() / 1000),
    };
    if (input.accessToken) payload.ath = accessTokenHash(input.accessToken);
    if (input.nonce) payload.nonce = input.nonce;
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    // JWS ES256 uses the raw r||s signature, not DER.
    const signature = sign("sha256", Buffer.from(signingInput), { key: this.key, dsaEncoding: "ieee-p1363" });
    return `${signingInput}.${b64url(signature)}`;
  }
}
