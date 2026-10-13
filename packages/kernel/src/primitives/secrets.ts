import type { Driver, Json } from "../driver.ts";

// Crypto ported from v1 packages/shared/src/crypto.ts.

const IV_BYTES = 12;

export type Keys = { current: number; byVersion: Record<number, CryptoKey> };

const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const text = new TextEncoder();

export const base64url = (b: Uint8Array) => b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromBase64url = (s: string) =>
  bytes(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
export const randomId = (n = 16) => base64url(crypto.getRandomValues(new Uint8Array(n)));

export const importAesKey = (base64Key: string) =>
  crypto.subtle.importKey("raw", bytes(base64Key), "AES-GCM", false, ["encrypt", "decrypt"]);

export const importHmacKey = (base64Key: string) =>
  crypto.subtle.importKey("raw", bytes(base64Key), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

/** Keys from env-style base64 strings, e.g. `importKeys({ 1: env.KEY_V1, 2: env.KEY_V2 }, 2)`. */
export async function importKeys(byVersion: Record<number, string>, current: number): Promise<Keys> {
  const out: Record<number, CryptoKey> = {};
  for (const [v, k] of Object.entries(byVersion)) out[Number(v)] = await importAesKey(k);
  return { current, byVersion: out };
}

/** Output is prefixed with a key-version byte so keys can rotate without a re-encrypt migration. */
export async function encrypt(plaintext: string, keys: Keys): Promise<string> {
  const key = keys.byVersion[keys.current];
  if (!key || keys.current < 0 || keys.current > 255) throw new Error(`bad current key version ${keys.current}`);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, text.encode(plaintext)));
  const packed = new Uint8Array(1 + IV_BYTES + ct.length);
  packed[0] = keys.current;
  packed.set(iv, 1);
  packed.set(ct, 1 + IV_BYTES);
  return b64(packed);
}

export async function decrypt(packedB64: string, keys: Keys): Promise<string> {
  const packed = bytes(packedB64);
  const key = keys.byVersion[packed[0] ?? -1];
  if (!key) throw new Error(`no key for version ${packed[0]}`);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.slice(1, 1 + IV_BYTES) }, key, packed.slice(1 + IV_BYTES));
  return new TextDecoder().decode(pt);
}

/** The key version a sealed value was encrypted under. */
export const keyVersion = (packedB64: string) => bytes(packedB64.slice(0, 4))[0];

/** Opaque signed value: base64url(payload).base64url(hmac). Lets a callback route to its instance without a lookup. */
export async function sign(payload: string, key: CryptoKey): Promise<string> {
  const encoded = base64url(text.encode(payload));
  return `${encoded}.${base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, text.encode(encoded))))}`;
}

/** The payload, or null if forged or malformed (bad base64 included: input from the outside never throws). */
export async function verify(signed: string, key: CryptoKey): Promise<string | null> {
  const [encoded, sig, extra] = signed.split(".");
  if (!encoded || !sig || extra !== undefined) return null;
  try {
    // subtle.verify compares in constant time.
    const ok = await crypto.subtle.verify("HMAC", key, fromBase64url(sig), text.encode(encoded));
    return ok ? new TextDecoder().decode(fromBase64url(encoded)) : null;
  } catch {
    return null;
  }
}

/**
 * Encrypted values in the instance store (connector client secrets, API keys).
 * Rotation: add the new key version and make it current. Values sealed under an older key
 * are re-sealed on read; retire the old key once nothing sealed under it remains.
 */
export function secrets(d: Driver, keys: Keys) {
  const k = (name: string) => `secret:${name}`;
  return {
    async put(name: string, value: Json) {
      await d.store.put(k(name), await encrypt(JSON.stringify(value), keys));
    },
    async get(name: string): Promise<Json | null> {
      const r = await d.store.get(k(name));
      if (!r) return null;
      const sealed = r.value as string;
      const value = JSON.parse(await decrypt(sealed, keys)) as Json;
      // Losing this cas is fine: whoever wrote sealed under the current key too.
      if (keyVersion(sealed) !== keys.current) await d.store.cas(k(name), r.v, await encrypt(JSON.stringify(value), keys));
      return value;
    },
    delete: (name: string) => d.store.delete(k(name)),
  };
}
