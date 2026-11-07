// No imports: the deploy generator and its vitest config (Node) use these too.

/**
 * The environment names (#86). One root key per project, `CONNECTD_ROOT_KEY`: `connectd init` makes
 * it once, it never changes, and it stays with the CLI (a teammate's `.env`, a CI secret): never on
 * the network, never in a deployment. Every key a deployment holds is derived from it per
 * environment (`derive`), so a deploy from any machine with the root key sends the same values.
 *
 * `CONNECTD_KEY_V<n>`: encryption keys by version, the highest is current (#10).
 * `CONNECTD_API_KEY`, `CONNECTD_EVENTS_SECRET`: the app's (made with `connectd keys`, kept in the
 * deployment's database); the runtime never reads them.
 */
export const ENV = {
  root: "CONNECTD_ROOT_KEY",
  url: "CONNECTD_PUBLIC_URL",
  key: "CONNECTD_KEY_V",
  state: "CONNECTD_STATE_KEY",
  sessions: "CONNECTD_SESSIONS_KEY",
  webhooks: "CONNECTD_WEBHOOKS_KEY",
  admin: "CONNECTD_ADMIN_KEY",
  /** The app's: where it calls connectd, with which key, and how it verifies events. */
  appUrl: "CONNECTD_URL",
  apiKey: "CONNECTD_API_KEY",
  events: "CONNECTD_EVENTS_SECRET",
} as const;

/** dev's environment name: its keys are derived under it. */
export const DEV_ENV = "dev";

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** A new root key: `ocroot_` + 32 random bytes, base64. */
export const newRootKey = () => `ocroot_${b64(crypto.getRandomValues(new Uint8Array(32)))}`;

/** The root key's bytes, or an error naming what's wrong. */
function rootBytes(root: string): Uint8Array<ArrayBuffer> {
  const m = /^ocroot_([A-Za-z0-9+/]{43}=)$/.exec(root.trim());
  if (!m) throw new Error(`${ENV.root} isn't a connectd root key (ocroot_ + 32 bytes, base64): \`connectd init\` makes one`);
  return unb64(m[1] as string);
}

/** One derived key: HMAC-SHA256(root, `connectd/<environment>/<purpose>`), base64. */
export async function derive(root: string, environment: string, purpose: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", rootBytes(root), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`connectd/${environment}/${purpose}`))));
}

/**
 * Every key a deployment of `environment` holds, with encryption key versions 1..`versions`
 * (a rotation adds one; older ones stay, to open what was sealed with them).
 */
export async function deploymentKeys(root: string, environment: string, versions = 1): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let v = 1; v <= versions; v++) out[`${ENV.key}${v}`] = await derive(root, environment, `encryption/v${v}`);
  for (const [name, purpose] of [
    [ENV.state, "state"],
    [ENV.sessions, "sessions"],
    [ENV.webhooks, "webhooks"],
    [ENV.admin, "admin"],
  ] as const)
    out[name] = await derive(root, environment, purpose);
  return out;
}

/** Whether `name` is one of the keys deploy derives (never read from an env file). */
export const isDerived = (name: string) => name.startsWith(ENV.key) || ([ENV.state, ENV.sessions, ENV.webhooks, ENV.admin] as string[]).includes(name);
