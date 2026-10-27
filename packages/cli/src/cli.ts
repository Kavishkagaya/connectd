import { parse } from "./args.ts";
import { dev, PORT } from "./dev.ts";
import { join } from "node:path";
import { add, custom, diff, list } from "./add.ts";
import { TEMPLATES } from "./templates.ts";
import { init, TARGETS } from "./init.ts";
import { deploy } from "./deploy.ts";
import { workdir } from "./env.ts";
import { CONFIG_FILES, findConfig, loadProject } from "./load.ts";
import { sdkNote } from "./discover.ts";
import { ENV, generateKeys } from "./keys.ts";

export const HELP = `connectd <command> [flags]

Commands
  init      set up dev in your app: keys, CONNECTD_URL and APP_URL in .env, oc.config.ts, lib/oc.ts, the route
  dev       run the runtime locally: in memory, real clock, state kept in .connectd/, reloads on save
  deploy    deploy to your Cloudflare account (through wrangler)
  types     write .connectd/registry.d.ts (the typed client's registry; dev and deploy write it too)
  add       copy a provider into the project: connectd add github (no name: the catalog; --custom: your own)
  diff      what changed upstream in a copied provider: connectd diff github
  keys      print a new CONNECTD_API_KEY and CONNECTD_EVENTS_SECRET (for CI secrets and your app's host)
  help      this text

connectd init
  --port <n>       where connectd dev will run (default ${PORT}; written as CONNECTD_URL)
  --app-url <url>  your app's origin (default APP_URL from .env, else http://localhost:3000)
  --target <t>     where it deploys: ${Object.keys(TARGETS).join(", ")} or none (default: asked in a terminal); installs the target's packages
  --skip-install   don't install the target's packages
  Writes only what's missing; keys an older connectd dev kept in .connectd/dev.vars move to .env.

connectd dev
  --port <n>       port (default CONNECTD_URL's in .env, else ${PORT}; 0 picks a free one)
  --config <file>  config file (default ${CONFIG_FILES[0]})
  --tunnel         expose it on a public https URL with a cloudflared quick tunnel (Slack needs https)
  --url <url>      public URL of a tunnel you run yourself (callback and webhook URLs use it)
  --reset          start from empty state

connectd add <provider>
  --id <id>        the folder (the connection's id; default the provider's name)
  --force          overwrite an existing connection.ts (diff first)
  --registry <src> the catalog: a base URL or a folder (default CONNECTD_REGISTRY, else the connectd repo at this version)
  Writes <dir>/<id>/connection.ts and an empty events.ts, and adds its env names to .env.

connectd add --custom <id>
  --template <flow> ${TEMPLATES.join(", ")} (default oauth2)
  --force          overwrite an existing connection.ts
  A provider the catalog doesn't have: the same files, from a template to fill in.

connectd deploy
  --env <name>     the environment (default production): reads .env.<name>, deploys its own Worker and
                   database (<name>-staging), generates its own keys; your provider credentials per env
  --env-file <f>   the env file instead (default .env.<env>; in CI, CI=true, the shell's); only names the project reads are pushed
  --name <name>    Worker name (default: the target's name, cloudflare({ name }), else the directory's name)
  --url <url>      public https origin on a custom domain (default: the workers.dev URL)
  --rotate <list>  comma-separated: key (adds CONNECTD_KEY_V<n+1>), api-key, events, state, sessions
  --new-keys       generate fresh runtime keys although the index database exists without its Worker
  --dry-run        write .connectd/deploy/ (entry, wrangler.json, migrations) and print the plan; no Cloudflare calls
  --config <file>  config file (default ${CONFIG_FILES[0]})
  Needs wrangler (npm i -D wrangler) logged in (wrangler login, or CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID).
  In CI, CONNECTD_API_KEY comes from a CI secret (connectd keys); deploy never prints one there.
  Managed deploys (--managed) wait for the managed service (#34).
`;

const SPEC = {
  help: "boolean",
  port: "string",
  config: "string",
  tunnel: "boolean",
  url: "string",
  reset: "boolean",
  "env-file": "string",
  env: "string",
  name: "string",
  rotate: "string",
  "dry-run": "boolean",
  "new-keys": "boolean",
  managed: "boolean",
  id: "string",
  force: "boolean",
  registry: "string",
  custom: "string",
  template: "string",
  "app-url": "string",
  target: "string",
  "skip-install": "boolean",
} as const;

/** Runs a command; resolves to an exit code, or to a running dev server's stop function. */
export async function main(argv: string[], o: { dir?: string; log?: (s: string) => void } = {}): Promise<number | (() => Promise<void>)> {
  const log = o.log ?? console.log;
  let a: ReturnType<typeof parse>;
  try {
    a = parse(argv, SPEC);
  } catch (e) {
    log(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (a.flags.help || !a.command || a.command === "help") return log(HELP), a.command || a.flags.help ? 0 : 2;
  switch (a.command) {
    case "init": {
      const port = a.flags.port === undefined ? undefined : Number(a.flags.port);
      if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) return log(`--port must be a port number`), 2;
      const target = a.flags.target;
      if (typeof target === "string" && target !== "none" && !Object.hasOwn(TARGETS, target))
        return log(`--target must be one of ${Object.keys(TARGETS).join(", ")}, none`), 2;
      try {
        await init({
          dir: o.dir ?? process.cwd(),
          ...(port ? { port } : {}),
          ...(typeof a.flags["app-url"] === "string" ? { appUrl: a.flags["app-url"] } : {}),
          ...(typeof target === "string" ? { target: target as keyof typeof TARGETS | "none" } : {}),
          ...(a.flags["skip-install"] ? { skipInstall: true } : {}),
          log,
        });
        return 0;
      } catch (e) {
        log((e as Error).message);
        return 1;
      }
    }
    case "dev": {
      const port = a.flags.port === undefined ? undefined : Number(a.flags.port);
      if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536)) return log(`--port must be a port number`), 2;
      try {
        const d = await dev({
          dir: o.dir ?? process.cwd(),
          ...(port !== undefined ? { port } : {}),
          ...(typeof a.flags.config === "string" ? { config: a.flags.config } : {}),
          ...(typeof a.flags.url === "string" ? { url: a.flags.url } : {}),
          ...(a.flags.tunnel ? { tunnel: true } : {}),
          ...(a.flags.reset ? { reset: true } : {}),
          log,
        });
        return d.stop;
      } catch (e) {
        log((e as Error).message);
        return 1;
      }
    }
    case "deploy": {
      if (a.flags.managed) return log("managed deploys wait for the managed service (#34); deploy to your own account without --managed"), 1;
      const dir = o.dir ?? process.cwd();
      const str = (k: string) => (typeof a.flags[k] === "string" ? (a.flags[k] as string) : undefined);
      try {
        const config = findConfig(dir, str("config"));
        const name = str("name");
        const url = str("url");
        const envFile = str("env-file");
        const environment = str("env");
        await deploy({
          dir,
          load: (env) => loadProject(dir, config, join(workdir(dir), "build"), Date.now(), env),
          ...(name ? { name } : {}),
          ...(url ? { url } : {}),
          ...(envFile ? { envFile } : {}),
          ...(environment ? { environment } : {}),
          rotate: (str("rotate") ?? "").split(",").map((r) => r.trim()),
          dryRun: !!a.flags["dry-run"],
          newKeys: !!a.flags["new-keys"],
          log,
        });
        return 0;
      } catch (e) {
        log((e as Error).message);
        return 1;
      }
    }
    case "add":
    case "diff": {
      const dir = o.dir ?? process.cwd();
      const str = (k: string) => (typeof a.flags[k] === "string" ? (a.flags[k] as string) : undefined);
      const base = { dir, env: { ...process.env }, log, ...(str("config") ? { config: str("config") } : {}), ...(str("registry") ? { registry: str("registry") } : {}) };
      const [name, ...extra] = a.rest;
      if (extra.length) return log(`${a.command} takes one name`), 2;
      try {
        if (a.command === "diff") {
          if (!name) return log("connectd diff <id>: the connection folder to compare"), 2;
          // 1 when they differ, like diff(1).
          return (await diff({ ...base, id: name })) ? 1 : 0;
        } else if (str("custom") !== undefined) {
          if (name) return log("connectd add --custom <id> takes no provider"), 2;
          await custom({ ...base, id: str("custom")!, ...(str("template") ? { template: str("template") } : {}), force: !!a.flags.force });
        } else if (str("template")) return log("--template goes with --custom <id>"), 2;
        else if (!name) await list(base);
        else await add({ ...base, provider: name, ...(str("id") ? { id: str("id") } : {}), force: !!a.flags.force });
        return 0;
      } catch (e) {
        log((e as Error).message);
        return 1;
      }
    }
    case "keys": {
      // The two values that are yours: the same in CI secrets (or .env.production) and in your app's host.
      const k = generateKeys();
      log(
        [
          `${ENV.apiKey}=${k[ENV.apiKey]}`,
          `${ENV.events}=${k[ENV.events]}`,
          "",
          "Put both in your CI secrets (or .env.production) and in your app's environment. New each run; nothing is stored.",
        ].join("\n"),
      );
      return 0;
    }
    case "types": {
      const dir = o.dir ?? process.cwd();
      try {
        const config = findConfig(dir, typeof a.flags.config === "string" ? a.flags.config : undefined);
        const env = { ...process.env };
        const { found, config: loaded } = await loadProject(dir, config, join(workdir(dir), "build"), Date.now(), env);
        // The names are the keys of each folder's actions.ts; building the config also checks them.
        const p = typeof loaded === "function" ? loaded(env) : loaded;
        const names = (id: string) => Object.keys(p.actions?.[id] ?? {});
        log(`wrote .connectd/registry.d.ts and app.ts (${found.length ? found.map((f) => `${f.id}${names(f.id).length ? ` (${names(f.id).join(", ")})` : ""}`).join(", ") : "no connection folders"})`);
        const note = sdkNote(dir);
        if (note) log(note);
        return 0;
      } catch (e) {
        log((e as Error).message);
        return 1;
      }
    }
    default:
      return log(`unknown command ${a.command}\n\n${HELP}`), 2;
  }
}
