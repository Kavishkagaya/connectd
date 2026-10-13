import { importHmacKey, importKeys } from "@openconnect/kernel";
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
 *     config: { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } },
 *     events: { url: "http://localhost:3000/api/openconnect" },
 *     sessions: { origins: ["http://localhost:3000"] },
 *   }));
 */
export type Project = {
  definitions: AnyDefinition[];
  /** Connector config by definition id (client id/secret). Definitions with no callback step (`apiKey`) default to null. */
  config?: Record<string, unknown>;
  /** Where lifecycle and webhook events are POSTed (#24); signed with `OPENCONNECT_EVENTS_SECRET`. */
  events?: { url: string };
  /** Exact origins the frontend connect UI runs on (#29). */
  sessions?: { origins: string[] };
  /** Extra extensions, after the built-in ones (proxy, events, webhooks, sessions, index). */
  extensions?: Extension[];
};

export type Env = Record<string, string | undefined>;
/** A project, or a function of the environment (`.dev.vars` and the process env in dev, Worker vars and secrets deployed). */
export type Config = Project | ((env: Env) => Project);

export const defineConfig = <T extends Config>(c: T) => c;

/** The environment the runtime reads. `OPENCONNECT_KEY_V<n>`: encryption keys by version, the highest is current (#10). */
export const ENV = {
  url: "OPENCONNECT_PUBLIC_URL",
  apiKey: "OPENCONNECT_API_KEY",
  key: "OPENCONNECT_KEY_V",
  state: "OPENCONNECT_STATE_KEY",
  sessions: "OPENCONNECT_SESSIONS_KEY",
  webhooks: "OPENCONNECT_WEBHOOKS_KEY",
  events: "OPENCONNECT_EVENTS_SECRET",
} as const;

const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

/** Fresh values for every generated secret: dev keeps them in `.openconnect/dev.vars`, deploy sets them as Worker secrets. */
export const generateKeys = (): Record<string, string> => ({
  [ENV.apiKey]: `oc_${random().replace(/[+/=]/g, "").slice(0, 32)}`,
  [`${ENV.key}1`]: random(),
  [ENV.state]: random(),
  [ENV.sessions]: random(),
  [ENV.webhooks]: random(),
  [ENV.events]: `whsec_${random()}`,
});

/** The project with definitions checked: unique, non-empty ids. */
export function resolve(config: Config, env: Env): Project & { registry: Record<string, AnyDefinition> } {
  const p = typeof config === "function" ? config(env) : config;
  if (!p || !Array.isArray(p.definitions)) throw new Error("the config must export { definitions: [...] }");
  const registry: Record<string, AnyDefinition> = {};
  for (const d of p.definitions) {
    if (!d?.id || typeof d.id !== "string") throw new Error("every definition needs an id (defineConnection({ id, ... }))");
    if (Object.hasOwn(registry, d.id)) throw new Error(`two definitions with id ${d.id}`);
    registry[d.id] = d;
  }
  return { ...p, registry };
}

/** Definitions that need connector config and have none: they answer `not_configured`. */
export const unconfigured = (p: Project) => p.definitions.filter((d) => !d.auth.fields && p.config?.[d.id] == null).map((d) => d.id);

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
  for (const d of p.definitions) if (d.auth.fields) config[d.id] = null;
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
 * dev, D1 deployed (`d1Index`). Each built-in extension is a no-op until its settings are set.
 */
export function options(config: Config, env: Env, index: Index): RuntimeOptions & { project: Project } {
  const project = resolve(config, env);
  let loaded: Promise<Settings> | undefined;
  return {
    project,
    definitions: project.registry,
    settings: () => (loaded ??= settings(project, env)),
    extensions: [proxy(), events(), webhooks(), sessions(), directory(index), ...(project.extensions ?? [])],
  };
}
