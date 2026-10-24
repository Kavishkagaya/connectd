import { base64url, fromBase64url, type Json } from "@openconnect/kernel";

/**
 * JWTs for the flows that need them (#56): RS256 signing for JWT-bearer grants and GitHub App
 * tokens, and id_token verification (RS256, ES256) for OIDC. WebCrypto only, so it runs in Workers.
 */

export type Claims = Record<string, Json>;

const utf8 = new TextEncoder();
const part = (v: Json) => base64url(utf8.encode(JSON.stringify(v)));

/** Header and claims, not verified. */
export function decodeJwt(token: string): { header: Claims; claims: Claims } {
  const [h, c] = token.split(".");
  if (!h || !c) throw new Error("not a JWT");
  const read = (s: string) => JSON.parse(new TextDecoder().decode(fromBase64url(s))) as Claims;
  return { header: read(h), claims: read(c) };
}

// DER length, for wrapping a PKCS#1 key into PKCS#8.
const len = (n: number) => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]);
// SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL } }
const RSA_ALG = [0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];

/** A PEM private key for RS256: PKCS#8 (`BEGIN PRIVATE KEY`, Google) or PKCS#1 (`BEGIN RSA PRIVATE KEY`, GitHub Apps). */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  let der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    const octet = [0x04, ...len(der.length), ...der];
    const inner = [...RSA_ALG, ...octet];
    der = new Uint8Array([0x30, ...len(inner.length), ...inner]);
  }
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

/** Sign `claims` with RS256. */
export async function signJwt(claims: Claims, key: CryptoKey, header: Claims = {}): Promise<string> {
  const input = `${part({ alg: "RS256", typ: "JWT", ...header })}.${part(claims)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8.encode(input));
  return `${input}.${base64url(new Uint8Array(sig))}`;
}

/** A public key from a JWKS (`kty`, `n`, `e` or `crv`, `x`, `y`). */
export type Jwk = { kty: string; kid?: string; alg?: string; [k: string]: unknown };

type Alg = Parameters<typeof crypto.subtle.importKey>[2];
const ALGS: Record<string, { import: Alg; verify: Parameters<typeof crypto.subtle.verify>[0] }> = {
  RS256: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: "RSASSA-PKCS1-v1_5" },
  ES256: { import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
};

/**
 * Check a JWT's signature against a key set and return its claims. Null if no key has its `kid`
 * (the caller refetches the keys once: they rotate). Throws on a bad signature or an unsupported `alg`.
 * Checks no claims: that's the caller's (iss, aud, exp, nonce).
 */
export async function verifyJwt(token: string, keys: Jwk[]): Promise<Claims | null> {
  const { header, claims } = decodeJwt(token);
  const alg = ALGS[String(header.alg)];
  if (!alg) throw new Error(`unsupported JWT alg ${String(header.alg)}`);
  const jwk = keys.find((k) => (header.kid === undefined || k.kid === header.kid) && (k.alg === undefined || k.alg === header.alg));
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk as never, alg.import, false, ["verify"]);
  const [h, c, s] = token.split(".");
  if (!(await crypto.subtle.verify(alg.verify, key, fromBase64url(s ?? ""), utf8.encode(`${h}.${c}`)))) throw new Error("bad JWT signature");
  return claims;
}
