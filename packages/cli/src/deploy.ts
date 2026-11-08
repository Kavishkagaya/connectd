import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { admin, type Made, rememberUrl } from "./admin.ts";
import { parseEnv, workdir } from "./env.ts";
import { deploymentKeys, derive, ENV, type Env, isDerived, resolve, unconfiguredText } from "./project.ts";
import type { Adapter, Deployed } from "./target.ts";

/**
 * `connectd deploy` (#31): what every target shares. The production environment (and the checks
 * that keep dev values out of it), the project resolved against it, the secrets (only the names it
 * reads, plus the deployment's keys, derived from the root key for this environment, #86), then the
 * target's adapter (`target: cloudflare(...)` in the config, @kavishkagaya/connectd-cloudflare) does
 * the rest. A first deploy makes the app's API key (and events secret) through `/admin`; the app's
 * env lines close it.
 */

/** What `--rotate` takes. Everything else derives from the root key, which never changes. */
const ROTATABLE = { key: "encryption key (a new CONNECTD_KEY_V<n>)" } as const;
/** Environment names that are dev's (`.env`, `.env.development`, `.env.local`), never a deployment's. */
const DEV_ENVS = ["development", "dev", "local"];

export type DeployOptions = {
  dir: string;
  /** The config and the entry to bundle (`loadProject`: the config plus folder discovery). */
  load: (env: import("./project.ts").Env) => Promise<{ config: import("./project.ts").Config; entry: string }>;
  name?: string;
  url?: string;
  /**
   * The environment (`--env staging`): its own env file (`.env.<name>`), its own deployment (the
   * target names it apart: Cloudflare's `<name>-staging` Worker and database), its own keys.
   * Default `production` (`.env.production`, the target's plain name).
   */
  environment?: string;
  /** The production env file. Default `.env.production`, else the shell environment; only the names the project reads become secrets. */
  envFile?: string;
  rotate?: string[];
  dryRun?: boolean;
  /** The target's deploy tool (Cloudflare: wrangler). Default: the adapter's own lookup. */
  wrangler?: string;
  env?: Env;
  /** Calls the deployed `/admin` (tests pass one). */
  fetch?: typeof fetch;
  log?: (line: string) => void;
};

export async function deploy(o: DeployOptions): Promise<Deployed> {
  const log = o.log ?? console.log;
  const env = o.env ?? process.env;
  const work = workdir(o.dir);

  // The production environment: --env-file, else .env.production, else (in CI only) the shell's:
  // a local shell holds dev's .env too (Bun loads it). Never the dev keys: the adapter generates the
  // deployment's own.
  const ci = !!env.CI && env.CI !== "false" && env.CI !== "0";
  const environment = o.environment ?? "production";
  if (!/^[a-z][a-z0-9-]{0,19}$/.test(environment)) throw new Error(`--env ${environment}: lowercase letters, digits and dashes (staging, prod, preview-1)`);
  if (DEV_ENVS.includes(environment)) throw new Error(`--env ${environment} is dev's (connectd dev reads .env); deploy environments are the others: staging, production, ...`);
  const own = `.env.${environment}`;
  const prod = join(o.dir, own);
  const file = o.envFile ? resolvePath(o.dir, o.envFile) : existsSync(prod) ? prod : undefined;
  const from = file ? relative(o.dir, file) : "the shell environment";
  if (file && !existsSync(file)) throw new Error(`no env file ${o.envFile}`);
  if (!file && !ci)
    throw new Error(`no ${own}: put the ${environment} values there (your provider credentials for ${environment}), or pass --env-file. In CI (CI=true) deploy reads the shell environment (your CI secrets) instead.`);
  const devVars = join(work, "dev.vars");
  if (file === devVars) throw new Error(`.connectd/dev.vars holds dev keys; deploy generates its own. Put ${environment} values in ${own}`);
  if (file === join(o.dir, ".env")) throw new Error(`.env is dev's; put ${environment} values in ${own} (or the shell environment)`);
  const source: Env = file ? parseEnv(readFileSync(file, "utf8")) : env;
  // Dev's values, by file: none of them may go to production (a dev OAuth app, a dev key).
  const devFiles = [devVars, ...[".env", ".env.local", ".env.development"].map((f) => join(o.dir, f))].filter((f) => existsSync(f));
  const devValues = devFiles.flatMap((f) => Object.entries(parseEnv(readFileSync(f, "utf8"))).map(([k, v]) => ({ k, v, f: relative(o.dir, f) })));
  if (file)
    for (const k of Object.keys(source)) {
      if (k === ENV.url) throw new Error(`${ENV.url} comes from --url (or the workers.dev URL), not the env file`);
      if (isDerived(k)) throw new Error(`${k} is derived from ${ENV.root} for each environment; remove it from ${from}`);
      if (k === ENV.apiKey || k === ENV.events) throw new Error(`${k} is your app's (\`connectd keys create --env ${environment}\` makes one); remove it from ${from}`);
    }
  // The root key: the env file's or the shell's (CI), else dev's .env (one root key per project). Never sent.
  const root = source[ENV.root] || env[ENV.root] || parseEnv(existsSync(join(o.dir, ".env")) ? readFileSync(join(o.dir, ".env"), "utf8") : "")[ENV.root];
  // A dry run sends nothing, so it needs no keys.
  if (!root && !o.dryRun) throw new Error(`no ${ENV.root}: deploy derives ${environment}'s keys from it. \`connectd init\` made one in .env${ci ? "; in CI, set it as a secret" : ""}`);
  if (root) await derive(root, environment, "check"); // a malformed root key fails here, before any step

  const { config, entry } = await o.load({ ...source });
  const project = resolve(config, { ...source });
  // Only what the project reads becomes a secret.
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) if (v && project.envNames.includes(k)) secrets[k] = v;
  for (const [k, v] of Object.entries(secrets)) {
    const d = devValues.find((x) => x.k === k && x.v && x.v === v);
    if (d) throw new Error(`${k} in ${from} is the dev value from ${d.f}; use a production one`);
  }
  const unsent = file ? Object.keys(source).filter((k) => !Object.hasOwn(secrets, k) && k !== ENV.root) : [];

  const rotate = (o.rotate ?? []).filter(Boolean);
  for (const r of rotate) {
    if (["api-key", "events"].includes(r)) throw new Error(`--rotate ${r} is gone: \`connectd keys roll <name> --env ${environment}\` rolls a key, with a grace period`);
    if (!Object.hasOwn(ROTATABLE, r)) throw new Error(`--rotate takes ${Object.keys(ROTATABLE).join(", ")} (the other keys derive from ${ENV.root})`);
  }

  const target = project.target;
  if (!target) throw new Error('deploy needs a target in oc.config.ts: `target: cloudflare({ name: "my-app" })` from @kavishkagaya/connectd-cloudflare (npm i -D @kavishkagaya/connectd-cloudflare)');
  const adapter = await load(o.dir, target.adapter);
  const missing = unconfiguredText(project);
  const r = await adapter.deploy({
    dir: o.dir,
    environment,
    entry,
    project,
    options: target.options ?? {},
    ...(o.name ? { name: o.name } : {}),
    ...(o.url ? { url: o.url } : {}),
    secrets,
    keys: (versions: number) => deploymentKeys(root as string, environment, versions),
    from,
    rotate,
    dryRun: !!o.dryRun,
    summary: [
      `  definitions  ${project.definitions.map((d) => d.id).join(", ") || "none"}`,
      ...(missing.length ? [`  no config    ${missing.join(", ")}   (not_configured until ${from} has them)`] : []),
      `  secrets      ${Object.keys(secrets).sort().join(", ") || "none"} from ${from}; the deployment's keys derived from ${ENV.root}${rotate.length ? `, rotating ${rotate.join(", ")}` : ""}`,
      ...(unsent.length ? [`  not sent     ${unsent.join(", ")}   (nothing in the project reads them)`] : []),
    ],
    ...(o.wrangler ? { bin: o.wrangler } : {}),
    env,
    log,
  });
  if (r.dryRun || !r.url) return r;
  rememberUrl(o.dir, environment, r.url);
  // The app's credentials: made on the first deploy (the database has none), shown once.
  const first = await firstKeys({ url: r.url, environment, root: root as string }, !!project.events, o.fetch ?? fetch).catch((e: Error) => {
    // Another root key than the one that made the deployment's keys: deploy replaced none of them.
    if (/refused the admin request/.test(e.message))
      log(`\n${r.url} holds keys from another ${ENV.root} than this one: deploy left them as they were, so its connections and your app's keys still work. Use the project's root key (the one its first deploy had) for deploy, \`connectd keys\` and \`connectd dashboard\`.`);
    else log(`\ncouldn't reach /admin yet (${e.message}); \`connectd keys create app --env ${environment}\` makes the app's key`);
    return null;
  });
  if (first) {
    const line = (kind: "api" | "events") => {
      const name = kind === "api" ? ENV.apiKey : ENV.events;
      const m = first.made.find((x) => x.info.kind === kind);
      if (m) return [`  ${name}=${m.key}   (new: shown once. \`connectd keys\` rolls or revokes it)`];
      return first.have[kind] ? [`  ${name}=the one you stored (${first.have[kind]} live; \`connectd keys --env ${environment}\` lists them)`] : [];
    };
    log(
      [
        "",
        `your app's env for ${environment} (where it calls connectd):`,
        `  CONNECTD_URL=${r.url}`,
        ...line("api"),
        ...(project.events ? line("events") : []),
        `\ndashboard: \`connectd dashboard --env ${environment}\` opens it signed in`,
      ].join("\n"),
    );
    r.keys = first.made;
  }
  return r;
}

/** The app's API key and events secret, made in a fresh deployment; `have`: how many live keys it had already. */
async function firstKeys(d: { url: string; environment: string; root: string }, events: boolean, f: typeof fetch): Promise<{ made: Made[]; have: { api: number; events: number } }> {
  // The Worker can take a moment to answer after its first deploy.
  const info = async (i = 0): Promise<{ keys: { api: number; events: number } }> => {
    try {
      return await admin(d, "GET", "/admin/info", undefined, f);
    } catch (e) {
      if (i >= 4 || !/can't reach|HTTP 5/.test((e as Error).message)) throw e;
      await new Promise((ok) => setTimeout(ok, 1000 * (i + 1)));
      return info(i + 1);
    }
  };
  const { keys: have } = await info();
  const made: Made[] = [];
  if (!have.api) made.push(await admin<Made>(d, "POST", "/admin/keys", { name: "app", kind: "api" }, f));
  if (events && !have.events) made.push(await admin<Made>(d, "POST", "/admin/keys", { name: "app", kind: "events" }, f));
  return { made, have };
}

/** The target's adapter module, resolved from the project, where it's installed. */
async function load(dir: string, id: string): Promise<Adapter> {
  let path: string;
  try {
    path = createRequire(join(dir, "package.json")).resolve(id);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") throw e;
    const pkg = id.split("/").slice(0, id.startsWith("@") ? 2 : 1).join("/");
    throw new Error(`the deploy target's adapter ${id} isn't installed: npm i -D ${pkg}`);
  }
  const m = (await import(pathToFileURL(path).href)) as Partial<Adapter>;
  if (typeof m.deploy !== "function") throw new Error(`${id} has no deploy(): not a deploy adapter`);
  return m as Adapter;
}
