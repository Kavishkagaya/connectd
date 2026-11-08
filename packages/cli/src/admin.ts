import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importHmacKey } from "@kavishkagaya/connectd-kernel";
import { ADMIN_TTL_MS, type KeyInfo, token } from "@kavishkagaya/connectd-runtime";
import { loadEnv, parseEnv, workdir } from "./env.ts";
import { DEV_ENV, derive, ENV, type Env } from "./project.ts";

/**
 * The CLI's side of a deployment's `/admin` (#86): which deployment (dev, or an environment by name
 * or URL), and requests signed with that environment's admin key, derived here from the root key.
 * The root key itself never goes over the network.
 */

/** How long a dashboard sign-in link works. */
export const LOGIN_TTL_MS = 5 * 60_000;

/** Where each environment was deployed (`connectd deploy` writes it), so later commands find it. */
const environments = (dir: string) => join(workdir(dir), "environments.json");

export function rememberUrl(dir: string, environment: string, url: string) {
  const f = environments(dir);
  const all = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, { url: string }>) : {};
  all[environment] = { url };
  writeFileSync(f, `${JSON.stringify(all, null, 2)}\n`);
}

const remembered = (dir: string, environment: string) => {
  const f = environments(dir);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, { url?: string }>)[environment]?.url : undefined;
};

const local = (u: string) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(u);

/** The project's root key: the shell's, else `.env`'s. */
export function rootKey(dir: string, env: Env = process.env): string {
  const r = env[ENV.root] || loadEnv(dir, {})[ENV.root];
  if (!r) throw new Error(`no ${ENV.root} (in .env or the shell): \`connectd init\` makes one; a teammate's or CI's is the same project's`);
  return r;
}

export type Deployment = { url: string; environment: string; root: string };

/**
 * Which deployment a command means. No flags: dev (CONNECTD_URL in .env). `--env <name>`: that
 * environment, at the URL its last deploy from here used, or `--url`. `--url` alone: a local URL is
 * dev, any other is production. Works outside the project too, given `--url` and the root key in the shell.
 */
export function deployment(dir: string, o: { environment?: string; url?: string; env?: Env }): Deployment {
  const env = o.env ?? process.env;
  const root = rootKey(dir, env);
  const devUrl = (env[ENV.appUrl] ?? loadEnv(dir, {})[ENV.appUrl] ?? "http://localhost:8787").replace(/\/+$/, "");
  const environment = o.environment ?? (o.url ? (local(o.url) ? DEV_ENV : "production") : DEV_ENV);
  const url = (o.url ?? (environment === DEV_ENV ? devUrl : remembered(dir, environment)))?.replace(/\/+$/, "");
  if (!url) throw new Error(`where is ${environment}? No deploy of it from here (.connectd/environments.json): pass --url https://…`);
  if (!/^https?:\/\/[^/]+$/.test(url)) throw new Error(`--url ${url}: an origin like https://connect.example.com`);
  return { url, environment, root };
}

const adminKey = async (d: Deployment) => importHmacKey(await derive(d.root, d.environment, "admin"));

/** One `/admin` request. Throws the deployment's error message, or why it couldn't be reached. */
export async function admin<T>(d: Deployment, method: "GET" | "POST", path: string, body?: unknown, f: typeof fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await f(`${d.url}${path}`, {
      method,
      headers: { authorization: `Admin ${await token(await adminKey(d), "admin", Date.now(), ADMIN_TTL_MS)}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    throw new Error(`can't reach ${d.url}${d.environment === DEV_ENV ? " (is `connectd dev` running?)" : ""}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const out = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) {
    if (res.status === 401) throw new Error(`${d.url} refused the admin request: its ${d.environment} keys aren't this root key's (another project, or deployed before \`connectd init\` made this one)`);
    throw new Error(out?.error ? `${out.error.code}: ${out.error.message}` : `${d.url}${path}: HTTP ${res.status}`);
  }
  return out as T;
}

/** A dashboard link that signs in on open (once, within LOGIN_TTL_MS). */
export async function loginUrl(d: Deployment) {
  return `${d.url}/dashboard#login=${await token(await adminKey(d), "login", Date.now(), LOGIN_TTL_MS)}`;
}

export type Made = { key: string; info: KeyInfo };

/** A key by id, or by name when one live key of `kind` has it (an API key and an events secret can share a name). */
export async function findKey(d: Deployment, which: string, kind: "api" | "events" = "api", f?: typeof fetch): Promise<KeyInfo> {
  const all = await admin<KeyInfo[]>(d, "GET", "/admin/keys", undefined, f);
  const byId = all.find((k) => k.id === which);
  if (byId) return byId;
  const named = all.filter((k) => k.name === which && k.kind === kind && k.status !== "revoked");
  if (named.length === 1) return named[0] as KeyInfo;
  throw new Error(named.length ? `${named.length} live keys are named ${which}: use the id (connectd keys)` : `no ${kind === "events" ? "events secret" : "API key"} ${which} in ${d.environment} (connectd keys lists them${kind === "api" ? "; --events for an events secret" : ""})`);
}

/** `30m`, `24h`, `7d`, `0`: milliseconds. */
export function duration(s: string): number {
  const m = /^(\d+)(s|m|h|d)?$/.exec(s.trim());
  if (!m) throw new Error(`--grace ${s}: a duration like 0, 30m, 24h or 7d`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] ?? "s") as "s"];
}

/** The app's env line for a new key. */
export const envLine = (k: Made) => `${k.info.kind === "events" ? ENV.events : ENV.apiKey}=${k.key}`;

/**
 * Put dev's own key in `.env` (the app's and connectd's one file): a line of that name is replaced,
 * else appended. Only `connectd dev` does, for the key it makes when `.env` has no working one;
 * `connectd keys` prints a new secret and leaves `.env` to you.
 */
export function writeEnv(dir: string, name: string, value: string): "added" | "replaced" {
  const f = join(dir, ".env");
  const text = existsSync(f) ? readFileSync(f, "utf8") : "";
  const re = new RegExp(`^(\\s*(?:export\\s+)?${name}\\s*=).*$`, "m");
  if (Object.hasOwn(parseEnv(text), name) && re.test(text)) {
    writeFileSync(f, text.replace(re, `${name}=${value}`), { mode: 0o600 });
    return "replaced";
  }
  writeFileSync(f, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${name}=${value}\n`, { mode: 0o600 });
  return "added";
}
