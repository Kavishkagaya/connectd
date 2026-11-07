import { api } from "./api";

/** The browser's half of WebAuthn: ask the deployment for a challenge, run the ceremony, send the result. */

const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const utf8 = (s: string) => new TextEncoder().encode(s);

export const supported = () => typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;

/** Add a passkey to the signed-in account. */
export async function register(name: string) {
  const o = await api<{ challenge: string; rpId: string; user: { id: string; name: string }; exclude: string[]; algorithms: number[] }>("/dashboard/api/auth/passkey/options", "POST", { mode: "register" });
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: utf8(o.challenge),
      rp: { id: o.rpId, name: "connectd" },
      user: { id: utf8(o.user.id), name: o.user.name, displayName: o.user.name },
      pubKeyCredParams: o.algorithms.map((alg) => ({ type: "public-key" as const, alg })),
      excludeCredentials: o.exclude.map((id) => ({ type: "public-key" as const, id: unb64url(id) })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      attestation: "none",
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was made.");
  const r = cred.response as AuthenticatorAttestationResponse;
  const publicKey = r.getPublicKey();
  if (!publicKey) throw new Error("This browser didn't give the passkey's public key; try another browser.");
  return api("/dashboard/api/auth/me/passkeys", "POST", {
    name,
    credential: { id: cred.id, clientDataJSON: b64url(r.clientDataJSON), authenticatorData: b64url(r.getAuthenticatorData()), publicKey: b64url(publicKey), alg: r.getPublicKeyAlgorithm() },
  });
}

/** Sign in with a passkey (the browser offers the ones it has for this site). */
export async function signIn() {
  const o = await api<{ challenge: string; rpId: string }>("/dashboard/api/auth/passkey/options", "POST", { mode: "login" });
  const cred = (await navigator.credentials.get({ publicKey: { challenge: utf8(o.challenge), rpId: o.rpId, userVerification: "preferred" } })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was chosen.");
  const r = cred.response as AuthenticatorAssertionResponse;
  return api("/dashboard/api/auth/passkey", "POST", { id: cred.id, clientDataJSON: b64url(r.clientDataJSON), authenticatorData: b64url(r.authenticatorData), signature: b64url(r.signature) });
}
