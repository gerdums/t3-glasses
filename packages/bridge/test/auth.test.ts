import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DpopSigner, accessTokenHash, generateDpopKey, jwkThumbprint } from "../src/dpop.js";
import { parsePairingLink } from "../src/pairing.js";

describe("DPoP", () => {
  it("signs ES256 proofs the public key verifies", () => {
    const signer = new DpopSigner(generateDpopKey());
    const proof = signer.proof({ method: "post", url: "https://env.example/api/x?y=1#z", accessToken: "token" });
    const [header, payload, signature] = proof.split(".");
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toMatchObject({ typ: "dpop+jwt", alg: "ES256" });
    expect(decoded).toMatchObject({ htm: "POST", htu: "https://env.example/api/x", ath: accessTokenHash("token") });
    const key = createPublicKey({ key: signer.material.publicJwk, format: "jwk" });
    const ok = verify("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"));
    expect(ok).toBe(true);
  });

  it("computes RFC 7638 thumbprints", () => {
    // RFC 7638 has no EC vector; this one is from RFC 9449 (DPoP), section 6.1 example key.
    const jwk = { kty: "EC" as const, crv: "P-256" as const, x: "l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs", y: "9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA" };
    expect(jwkThumbprint(jwk)).toBe("0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I");
  });
});

describe("pairing links", () => {
  it("reads direct and hosted links", () => {
    expect(parsePairingLink("https://m4.tail.ts.net:3773/pair#token=abc")).toEqual({ httpBaseUrl: "https://m4.tail.ts.net:3773", credential: "abc" });
    expect(parsePairingLink("https://app.t3.codes/pair?host=https%3A%2F%2Fenv.t3.codes#token=xyz")).toEqual({
      httpBaseUrl: "https://env.t3.codes",
      credential: "xyz",
    });
  });
  it("requires a token", () => {
    expect(() => parsePairingLink("https://m4/pair")).toThrow(/no token/);
  });
});

describe("glasses pairing codes", async () => {
  const { defaultConfig, issueGlassesCode, redeemGlassesCode } = await import("../src/config.js");
  it("redeems once, rejects wrong codes, and expires", () => {
    const config = defaultConfig();
    const code = issueGlassesCode(config, 0);
    expect(code).toMatch(/^\d{6}$/);
    expect(config.glassesPairing?.codeHash).not.toContain(code);
    expect(redeemGlassesCode(config, "000000" === code ? "111111" : "000000", 1)).toBe("invalid");
    expect(redeemGlassesCode(config, `${code.slice(0, 3)} ${code.slice(3)}`, 2)).toBe("ok");
    expect(redeemGlassesCode(config, code, 3)).toBe("expired");
    const late = issueGlassesCode(config, 0);
    expect(redeemGlassesCode(config, late, 11 * 60_000)).toBe("expired");
  });
  it("locks out after five wrong attempts", () => {
    const config = defaultConfig();
    const code = issueGlassesCode(config, 0);
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i += 1) redeemGlassesCode(config, wrong, 1);
    expect(redeemGlassesCode(config, code, 2)).toBe("expired");
  });
});
