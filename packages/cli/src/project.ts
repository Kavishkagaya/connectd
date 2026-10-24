import { type AnyAction, type AnyConnection, definitionOf, isAction, isConnection } from "@openconnect/connections";
import { dashboard } from "@openconnect/dashboard";
import { importHmacKey, importKeys } from "@openconnect/kernel";
import { ENV } from "./keys.ts";
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
 * A user's project: what `openconnect.config.ts` exports, the one input both `openconnect dev`
 * and `deploy` (#31) build the runtime from. No Node or Bun APIs here, so a Worker can import it.
 *
 *   export default defineConfig((env) => ({
 *     definitions: [github],
 *     actions: [starRepo, syncIssues],
 *     config: { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } },
 *     events: { url: "http://localhost:3000/api/openconnect" },
 *     sessions: { origins: ["http://localhost:3000"] },
 *   }));
 */
export type Project = {
  /** `connection(...)` builders, or plain definitions. */
  definitions: (AnyConnection | AnyDefinition)[];
  /** `action(id, connection)` builders (#54), each on one of `definitions`. */
  actions?: AnyAction[];
  /**
   * Folders whose files' exported connections and actions join `definitions` and `actions` (#54),
   * relative to the config. Default: `connections/` and `actions/`, where they exist. `[]`: none.
   */
  dirs?: string[];
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
  /**
   * `openconnect deploy` (#31): the Worker's name (default: the project directory's), and its public
   * URL when it isn't the workers.dev one (a custom domain, served at its root). Flags override both.
   */
  deploy?: { name?: string; url?: string };
};

export type Env = Record<string, string | undefined>;
/** A project, or a function of the environment (`.dev.vars` and the process env in dev, Worker vars and secrets deployed). */
export type Config = Project | ((env: Env) => Project);

export const defineConfig = <T extends Config>(c: T) => c;

export { ENV, generateKeys } from "./keys.ts";

/**
 * The config plus what folder discovery found (the generated entry calls this): every exported
 * connection and action of `modules` not already listed. A connection whose id is listed already
 * (a provider extended under the same id) stays as listed.
 */
export function withModules(config: Config, modules: Record<string, unknown>[]): Config {
  return (env) => {
    const p = typeof config === "function" ? config(env) : config;
    const found = modules.flatMap((m) => Object.values(m));
    const definitions = [...p.definitions];
    for (const c of found.filter(isConnection)) if (!definitions.some((d) => d === c || d.id === c.id)) definitions.push(c);
    const actions = [...(p.actions ?? [])];
    for (const a of found.filter(isAction)) if (!actions.includes(a)) actions.push(a);
    return { ...p, definitions, ...(actions.length ? { actions } : {}) };
  };
}

/** The project with definitions checked: unique, non-empty ids. */
export function resolve(config: Config, env: Env): Project & { registry: Record<string, AnyDefinition> } {
  const p = typeof config === "function" ? config(env) : config;
  if (!p || !Array.isArray(p.definitions)) throw new Error("the config must export { definitions: [...] }");
  const registry: Record<string, AnyDefinition> = {};
  for (const d of p.definitions) {
    if (!d?.id || typeof d.id !== "string") throw new Error("every definition needs an id (connection(id))");
    if (Object.hasOwn(registry, d.id)) throw new Error(`two definitions with id ${d.id}`);
    registry[d.id] = definitionOf(d);
  }
  return { ...p, registry };
}

/** Definitions that need connector config and have none: they answer `not_configured`. */
export const unconfigured = (p: Project) => p.definitions.filter((d) => !definitionOf(d).auth.fields && p.config?.[d.id] == null).map((d) => d.id);

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
  for (const d of p.definitions) if (definitionOf(d).auth.fields) config[d.id] = null;
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
export function options(config: Config, env: Env, index: Index): RuntimeOptions & { project: Project } {
  const project = resolve(config, env);
  let loaded: Promise<Settings> | undefined;
  return {
    project,
    definitions: project.registry,
    ...(project.actions ? { actions: project.actions } : {}),
    settings: () => (loaded ??= settings(project, env)),
    extensions: [proxy(), events(), webhooks(), sessions(), directory(index), ...(project.dashboard === false ? [] : [dashboard()]), ...(project.extensions ?? [])],
  };
}
