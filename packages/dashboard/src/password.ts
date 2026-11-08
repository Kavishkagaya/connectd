import { base64url, fromBase64url } from "@kavishkagaya/connectd-kernel";

/**
 * Dashboard passwords: PBKDF2-SHA256 with a random salt. ponytail: 100,000 iterations, workerd's
 * cap on PBKDF2 (OWASP asks 600,000); sign-ins are rate limited per username, and passkeys are the
 * suggested way in. Argon2id when Workers offer it.
 */
export const ITERATIONS = 100_000;
export const MIN_LENGTH = 12;

const derive = async (password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) => {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, k, 256));
};

/** Why a password won't do, or null. */
export const weak = (password: unknown) =>
  typeof password !== "string" ? "a password is text" : password.length < MIN_LENGTH ? `at least ${MIN_LENGTH} characters` : password.length > 1024 ? "at most 1024 characters" : null;

export async function hash(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${base64url(salt)}$${base64url(await derive(password, salt, ITERATIONS))}`;
}

/** Does `password` match `stored`? Compares in constant time. */
export async function check(password: string, stored: string): Promise<boolean> {
  const [scheme, n, salt, want] = stored.split("$");
  if (scheme !== "pbkdf2-sha256" || !n || !salt || !want) return false;
  const got = await derive(password, fromBase64url(salt) as Uint8Array<ArrayBuffer>, Number(n));
  const w = fromBase64url(want);
  let diff = got.length ^ w.length;
  for (let i = 0; i < got.length; i++) diff |= (got[i] as number) ^ (w[i] ?? 0);
  return diff === 0;
}
