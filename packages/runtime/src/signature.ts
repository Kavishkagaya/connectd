/**
 * Event signatures, Standard Webhooks scheme (https://www.standardwebhooks.com), so any of its
 * libraries can verify too. No imports: the SDK (#28) and user servers import this file alone.
 *
 *   webhook-id:        event id (`<instance>:<seq>`), same on every retry: dedupe on it
 *   webhook-timestamp: unix seconds of this attempt
 *   webhook-signature: `v1,` + base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`)), space-separated if several
 *
 * The secret is `whsec_` + base64 key bytes (the prefix is optional).
 */

const text = new TextEncoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const importSecret = (secret: string) =>
  crypto.subtle.importKey("raw", unb64(secret.replace(/^whsec_/, "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

/** The `webhook-signature` header value for one delivery attempt. */
export async function sign(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await importSecret(secret), text.encode(`${id}.${timestamp}.${body}`));
  return `v1,${b64(new Uint8Array(mac))}`;
}

/**
 * True if `body` was signed with `secret` within `toleranceSec` of `now` (ms). Pass the raw body,
 * before any JSON parsing. Several signatures in the header (key rotation): any one matching is enough.
 */
export async function verify(secret: string, headers: Headers, body: string, opts: { now?: number; toleranceSec?: number } = {}): Promise<boolean> {
  const id = headers.get("webhook-id");
  const ts = Number(headers.get("webhook-timestamp"));
  const sigs = headers.get("webhook-signature");
  if (!id || !sigs || !Number.isInteger(ts)) return false;
  if (Math.abs((opts.now ?? Date.now()) / 1000 - ts) > (opts.toleranceSec ?? 300)) return false;
  const key = await importSecret(secret);
  const data = text.encode(`${id}.${ts}.${body}`);
  for (const s of sigs.split(" ")) {
    const [v, mac] = s.split(",");
    if (v !== "v1" || !mac) continue;
    let raw;
    try {
      raw = unb64(mac);
    } catch {
      continue; // not base64
    }
    // subtle.verify compares in constant time.
    if (await crypto.subtle.verify("HMAC", key, raw, data)) return true;
  }
  return false;
}
