import { type AnyAction, type AnyConnection, definitionOf, envConfig, isAction, isConnection, withId } from "@openconnect/connections";
import { dashboard } from "@openconnect/dashboard";
import { importHmacKey, importKeys } from "@openconnect/kernel";
import { ENV } from "./keys.ts";
import type { Target } from "./target.ts";
import {
  type AnyDefinition,
  directory,
  events,
  type Extension,
  type Index,
  proxy,
  type RuntimeOptions,
  type Settings,
  sessions,
  webhooks,
} from "@openconnect/runtime";

/**
 * A user's project: what `oc.config.ts` exports, the one input both `openconnect dev` and `deploy`
 * (#31) build the runtime from. No Node or Bun APIs here, so a Worker can import it. Connections and
 * their actions live in folders under `dir`, one per connection, named by its id (#54):
 *
 *   src/oc/github/connection.ts        export default github   (or connection().config().auth(...))
 *   src/oc/github/actions/starRepo.ts  export default action({ input, run })
 *
 * Each connection reads its own env names (`.config((env) => ...)`; the providers' GITHUB_CLIENT_ID and so on).
 *
 *   export default defineConfig((env) => ({
 *     dir: "src/oc",
 *     events: { url: "http://localhost:3000/api/oc" },
 *     sessions: { origins: ["http://localhost:3000"] },
 *   }));
 */
export type Project = {
  /**
   * The connection folders' parent, relative to the config. Default: `src/oc` or `oc`, the first
   * that exists. dev, deploy and `types` read it (the Worker gets what they found).
   */
  dir?: string;
  /** Connections listed here instead of in a folder: `connection(id)` builders, or plain definitions. */
  definitions?: (AnyConnection | AnyDefinition)[];
  /** Actions of listed connections, by connection id, then by name: `{ github: { starRepo } }`. */
  actions?: Record<string, Record<string, AnyAction>>;
  /** Connector config by definition id (client id/secret). Definitions with no callback step (`apiKey`) default to null. */
  config?: Record<string, unknown>;
  /** Where lifecycle and webhook events are POSTed (#24); signed with `OPENCONNECT_EVENTS_SECRET`. */
  events?: { url: string };
  /** Exact origins the frontend connect UI runs on (#29). */
  sessions?: { origins: string[] };
  /** Extra extensions, after the built-in ones (proxy, events, webhooks, sessions, index, dashboard). */
  extensions?: Extension[];
  /** The dashboard at `/dashboard` (#32), signed in with the API key. Default true; false leaves it out. */
  dashboard?: boolean;
  /** Where `openconnect deploy` puts it (#54): `cloudflare({ name, url })` from @openconnect/cloudflare. dev ignores it. */
  target?: Target;
};

export type Env = Record<string, string | undefined>;
/** A project, or a function of the environment (`.env` and the process env in dev, Worker vars and secrets deployed), read one name at a time. */
export type Config = Project | ((env: Env) => Project);

export const defineConfig = <T extends Config>(c: T) => c;

export { ENV, generateKeys } from "./keys.ts";
export type { Adapter, DeployContext, Deployed, Target } from "./target.ts";

/** One connection folder, as the generated entry passes it: the folder's name and its files' default exports. */
export type Folder = { id: string; file: string; connection: unknown; actions: Record<string, unknown> };

/**
 * The config plus its connection folders (the generated entry calls this): each folder's
 * connection, named after the folder, and its actions. An id the config lists too is an error.
 */
export function withFolders(config: Config, folders: Folder[]): Config {
  return (env) => {
    const p = typeof config === "function" ? config(env) : config;
    const definitions = [...(p.definitions ?? [])];
    const actions = { ...p.actions };
    for (const f of folders) {
      const c = f.connection;
      if (!isConnection(c) && !(typeof c === "object" && c !== null && "auth" in c)) throw new Error(`${f.file}: the default export must be a connection (connection().config().auth(...), or a provider)`);
      if (definitions.some((d) => d.id === f.id)) throw new Error(`two connections with id ${f.id}: the config lists one and ${f.file} is another`);
      definitions.push(isConnection(c) ? withId(c, f.id) : { ...(c as AnyDefinition), id: f.id });
      for (const [name, a] of Object.entries(f.actions)) if (!isAction(a)) throw new Error(`${f.id}/actions/${name}: the default export must be an action({ ... })`);
      // Typed from the folder only: config-listed actions for it would run untyped (and could shadow one).
      if (Object.hasOwn(actions, f.id)) throw new Error(`actions for ${f.id} are in the config: put them in its folder's actions/`);
      if (Object.keys(f.actions).length) actions[f.id] = f.actions as Record<string, AnyAction>;
    }
    return { ...p, definitions, ...(Object.keys(actions).length ? { actions } : {}) };
  };
}

/**
 * A project as the runtime gets it: every definition (listed and from folders), checked; `config`
 * with each connection's own (`.config((env) => ...)`) filled in; `missing`: the required env names
 * a connection still lacks; `envNames`: every name the config and the connections read, the only
 * ones (besides `OPENCONNECT_*`) a Worker gets.
 */
export type Resolved = Project & {
  definitions: (AnyConnection | AnyDefinition)[];
  registry: Record<string, AnyDefinition>;
  missing: Record<string, string[]>;
  envNames: string[];
};

export function resolve(config: Config, env: Env): Resolved {
  const names = new Set<string>();
  // The names a function config reads, as connections' are counted.
  const seen = new Proxy(env, {
    get: (t, n) => (typeof n === "string" && names.add(n), Reflect.get(t, n)),
    has: (t, n) => (typeof n === "string" && names.add(n), Reflect.has(t, n)),
    // Listing or spreading env would count every name (PATH, tokens) as read, and send them all to the Worker.
    ownKeys: () => {
      throw new Error("the config reads env names one at a time (env.NAME): spreading or listing env isn't supported, since only the names read reach the Worker");
    },
  });
  const raw = typeof config === "function" ? config(seen) : config;
  if (!raw || typeof raw !== "object") throw new Error("the config must export defineConfig({ ... })");
  if (raw.definitions !== undefined && !Array.isArray(raw.definitions)) throw new Error("definitions must be a list");
  if ("deploy" in raw) throw new Error("deploy: { name, url } is now the target's: target: cloudflare({ name, url }) from @openconnect/cloudflare");
  const p = { ...raw, definitions: raw.definitions ?? [] };
  const registry: Record<string, AnyDefinition> = {};
  const own: Record<string, unknown> = {};
  const missing: Record<string, string[]> = {};
  for (const d of p.definitions) {
    if (!d?.id || typeof d.id !== "string") throw new Error("every definition needs an id (connection(id), or its folder's name)");
    if (Object.hasOwn(registry, d.id)) throw new Error(`two definitions with id ${d.id}`);
    const def = definitionOf(d);
    registry[d.id] = def;
    if (!def.configFrom) continue;
    if (p.config && Object.hasOwn(p.config, d.id))
      throw new Error(`${d.id} reads its own config from the environment (.config((env) => ...), e.g. a provider's GITHUB_CLIENT_ID); remove config.${d.id} from the config file`);
    const r = envConfig(def.configFrom, env);
    for (const n of r.read) names.add(n);
    own[d.id] = r.value;
    if (r.missing.length) missing[d.id] = r.missing;
  }
  return { ...p, config: { ...p.config, ...own }, registry, missing, envNames: [...names].filter((n) => !n.startsWith("OPENCONNECT_")).sort() };
}

/** What a Worker gets of `env`: the names the project reads, and `OPENCONNECT_*` (keys, URL, API key, events secret). */
export const workerEnv = (env: Env, names: string[]): Env =>
  Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && (k.startsWith("OPENCONNECT_") || names.includes(k))));

/** Definitions that need connector config and have none (they answer `not_configured`), or lack env names they read. */
export const unconfigured = (p: Project & { missing?: Record<string, string[]> }) =>
  (p.definitions ?? [])
    .filter((d) => (p.missing && Object.hasOwn(p.missing, d.id)) || (!definitionOf(d).auth.fields && (!p.config || !Object.hasOwn(p.config, d.id) || p.config[d.id] == null)))
    .map((d) => d.id);

/** `github (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET), notes`: the unconfigured ones, with the env names each lacks. */
export const unconfiguredText = (p: Resolved) => unconfigured(p).map((id) => (p.missing[id]?.length ? `${id} (${p.missing[id].join(", ")})` : id));

function need(env: Env, name: string) {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Settings from the environment. `OPENCONNECT_PUBLIC_URL` is where `/callback` and `/webhooks` are reached from outside. */
export async function settings(p: Project, env: Env): Promise<Settings> {
  const url = need(env, ENV.url).replace(/\/+$/, "");
  const versions = Object.keys(env).flatMap((k) => (k.startsWith(ENV.key) && env[k] ? [Number(k.slice(ENV.key.length))] : [])).filter(Number.isInteger);
  if (!versions.length) throw new Error(`${ENV.key}1 is not set`);
  const keys = Object.fromEntries(versions.map((v) => [v, env[`${ENV.key}${v}`] as string]));
  const config: Record<string, unknown> = {};
  for (const d of p.definitions ?? []) if (definitionOf(d).auth.fields) config[d.id] = null;
  return {
    keys: await importKeys(keys, Math.max(...versions)),
    stateKey: await importHmacKey(need(env, ENV.state)),
    apiKey: need(env, ENV.apiKey),
    redirectUri: `${url}/callback`,
    config: { ...config, ...p.config },
    webhooks: { url: `${url}/webhooks`, key: await importHmacKey(need(env, ENV.webhooks)) },
    ...(p.events ? { events: { url: p.events.url, secret: need(env, ENV.events) } } : {}),
    ...(p.sessions ? { sessions: { key: await importHmacKey(need(env, ENV.sessions)), origins: p.sessions.origins } } : {}),
  };
}

/**
 * Everything `runtime()` takes, for a config and an environment. The index is the host's: memory in
 * dev, D1 deployed (`d1Index`). Each built-in extension is a no-op until its settings are set; the
 * dashboard is on unless `dashboard: false`.
 */
export function options(config: Config, env: Env, index: Index): RuntimeOptions & { project: Resolved } {
  // Resolved against only what it reads, in dev and in the Worker alike (a Worker also holds
  // secrets from earlier deploys and `wrangler secret put`).
  const own = workerEnv(env, resolve(config, env).envNames);
  const project = resolve(config, own);
  let loaded: Promise<Settings> | undefined;
  return {
    project,
    definitions: project.registry,
    ...(project.actions ? { actions: project.actions } : {}),
    settings: () => (loaded ??= settings(project, own)),
    extensions: [proxy(), events(), webhooks(), sessions(), directory(index), ...(project.dashboard === false ? [] : [dashboard()]), ...(project.extensions ?? [])],
  };
}
