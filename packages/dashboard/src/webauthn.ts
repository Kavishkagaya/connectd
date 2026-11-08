import { base64url, fromBase64url } from "@kavishkagaya/connectd-kernel";

/**
 * Passkeys for dashboard accounts (#86): the server's half of WebAuthn, on WebCrypto alone.
 *
 * Registration takes the browser's own reading of the new credential (`getPublicKey()`: SPKI DER,
 * `getPublicKeyAlgorithm()`, `getAuthenticatorData()`), so there's no CBOR to parse. Attestation
 * isn't checked ("none", as most sites do): what's checked is that the browser ran the ceremony for
 * this origin, on a challenge this deployment issued, with the user present. Sign-in then proves
 * possession of the key: the signature over authenticatorData || SHA-256(clientDataJSON).
 *
 * Algorithms: ES256 (-7) and RS256 (-257), what every platform authenticator offers.
 */

export const ES256 = -7;
export const RS256 = -257;
export const ALGORITHMS = [ES256, RS256];

const utf8 = new TextEncoder();
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));
const bytes = (s: string) => fromBase64url(s) as Uint8Array<ArrayBuffer>;

/** The challenge bytes for a challenge string (a signed token): the browser echoes them base64url in clientDataJSON. */
export const challengeBytes = (challenge: string) => base64url(utf8.encode(challenge));

export class WebAuthnError extends Error {}
const fail = (m: string): never => {
  throw new WebAuthnError(m);
};

type ClientData = { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };

/** clientDataJSON checked for this ceremony and origin; returns the challenge string it carried. */
function clientData(json: string, type: "webauthn.create" | "webauthn.get", origin: string): string {
  let cd: ClientData;
  try {
    cd = JSON.parse(new TextDecoder().decode(bytes(json))) as ClientData;
  } catch {
    return fail("clientDataJSON isn't JSON");
  }
  if (cd.type !== type) fail(`not a ${type} ceremony`);
  if (cd.origin !== origin) fail(`made for ${cd.origin}, not ${origin}`);
  if (cd.crossOrigin) fail("made in a cross-origin frame");
  if (typeof cd.challenge !== "string") fail("no challenge");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes(cd.challenge as string));
  } catch {
    return fail("not a challenge of ours");
  }
}

/** authenticatorData: for this RP id, user present; its signature counter. */
async function authData(b64: string, rpId: string): Promise<{ raw: Uint8Array<ArrayBuffer>; counter: number }> {
  const raw = bytes(b64);
  if (raw.length < 37) fail("authenticatorData is too short");
  const rp = await sha256(utf8.encode(rpId));
  if (!rp.every((x, i) => x === raw[i])) fail(`not for ${rpId}`);
  if (!((raw[32] as number) & 0x01)) fail("the user wasn't present");
  const counter = new DataView(raw.buffer, raw.byteOffset + 33, 4).getUint32(0);
  return { raw, counter };
}

const importKey = (spki: Uint8Array<ArrayBuffer>, alg: number) =>
  crypto.subtle.importKey("spki", spki, alg === ES256 ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);

/** What registration gets from the browser, base64url. */
export type Attestation = { id: string; clientDataJSON: string; authenticatorData: string; publicKey: string; alg: number };
/** What sign-in gets from the browser, base64url. */
export type Assertion = { id: string; clientDataJSON: string; authenticatorData: string; signature: string };

/** A new credential, checked. Returns the challenge it answered (the caller checks it's its own, once). */
export async function registration(a: Attestation, origin: string, rpId: string): Promise<{ challenge: string; counter: number }> {
  if (typeof a.id !== "string" || !a.id || a.id.length > 1366) fail("bad credential id");
  if (!ALGORITHMS.includes(a.alg)) fail(`algorithm ${a.alg} isn't supported (ES256 or RS256)`);
  const challenge = clientData(a.clientDataJSON, "webauthn.create", origin);
  const { counter } = await authData(a.authenticatorData, rpId);
  try {
    await importKey(bytes(a.publicKey), a.alg);
  } catch {
    fail("the public key doesn't parse");
  }
  return { challenge, counter };
}

/** ES256 signatures come DER-encoded; WebCrypto wants r || s, 32 bytes each. */
export function derToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(64);
  if (der[0] !== 0x30) return fail("bad ES256 signature");
  let i = 2;
  for (const at of [0, 32]) {
    if (der[i] !== 0x02) fail("bad ES256 signature");
    let len = der[i + 1] as number;
    let start = i + 2;
    i = start + len;
    while (len > 32 && der[start] === 0) (start++, len--);
    if (len > 32) fail("bad ES256 signature");
    out.set(der.subarray(start, start + len), at + 32 - len);
  }
  return out;
}

/**
 * A sign-in, checked against the stored key. Returns the challenge it answered and the new counter.
 * A counter that doesn't go up (when the authenticator keeps one) is a cloned key: refused.
 */
export async function assertion(a: Assertion, key: { publicKey: string; alg: number; counter: number }, origin: string, rpId: string): Promise<{ challenge: string; counter: number }> {
  const challenge = clientData(a.clientDataJSON, "webauthn.get", origin);
  const { raw, counter } = await authData(a.authenticatorData, rpId);
  const signed = new Uint8Array(raw.length + 32);
  signed.set(raw);
  signed.set(await sha256(bytes(a.clientDataJSON)), raw.length);
  const sig = bytes(a.signature);
  const alg = key.alg === ES256 ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  const ok = await crypto.subtle.verify(alg, await importKey(bytes(key.publicKey), key.alg), key.alg === ES256 ? derToRaw(sig) : sig, signed);
  if (!ok) fail("the signature doesn't match");
  if ((counter !== 0 || key.counter !== 0) && counter <= key.counter) fail("the signature counter went backwards: a cloned key?");
  return { challenge, counter };
}
