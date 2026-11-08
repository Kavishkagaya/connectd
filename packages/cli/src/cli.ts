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
import { admin, deployment, duration, envLine, findKey, loginUrl, type Made } from "./admin.ts";
import { DEV_ENV, ENV } from "./keys.ts";
import type { KeyInfo } from "@kavishkagaya/connectd-runtime";
import { spawn } from "node:child_process";

export const HELP = `connectd <command> [flags]

Commands
  init      set up dev in your app: the root key, CONNECTD_URL and APP_URL in .env, oc.config.ts, lib/oc.ts, the route
  dev       run the runtime locally: real clock, state and keys kept in .connectd/, reloads on save
  deploy    deploy to your Cloudflare account (through wrangler)
  keys      a deployment's API keys and events secrets: list, create, roll, revoke
  dashboard open a deployment's dashboard, signed in
  types     write .connectd/registry.d.ts (the typed client's registry; dev and deploy write it too)
  add       copy a provider into the project: connectd add github (no name: the catalog; --custom: your own)
  diff      what changed upstream in a copied provider: connectd diff github
  help      this text

connectd init
  --port <n>       where connectd dev will run (default ${PORT}; written as CONNECTD_URL)
  --app-url <url>  your app's origin (default APP_URL from .env, else http://localhost:3000)
  --target <t>     where it deploys: ${Object.keys(TARGETS).join(", ")} or none (default: asked in a terminal); installs the target's packages
  --skip-install   don't install the target's packages
  Writes only what's missing. The root key (CONNECTD_ROOT_KEY) is the project's for good: every
  environment's keys derive from it. Keep a copy in your password manager; CI needs it as a secret.

connectd dev
  --port <n>       port (default CONNECTD_URL's in .env, else ${PORT}; 0 picks a free one)
  --config <file>  config file (default ${CONFIG_FILES[0]})
  --tunnel         expose it on a public https URL with a cloudflared quick tunnel (Slack needs https)
  --url <url>      public URL of a tunnel you run yourself (callback and webhook URLs use it)
  --reset          start from empty state (keys and dashboard accounts stay)
  Writes the app's dev CONNECTD_API_KEY (and CONNECTD_EVENTS_SECRET) into .env when missing.

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
                   database (<name>-staging) with its own keys (derived from the root key); your provider credentials per env
  --env-file <f>   the env file instead (default .env.<env>; in CI, CI=true, the shell's); only names the project reads are pushed
  --name <name>    Worker name (default: the target's name, cloudflare({ name }), else the directory's name)
  --url <url>      public https origin on a custom domain (default: the workers.dev URL)
  --rotate key     add an encryption key version (CONNECTD_KEY_V<n+1>); old ones stay to open older data
  --dry-run        write .connectd/deploy/ (entry, wrangler.json, migrations) and print the plan; no Cloudflare calls
  --config <file>  config file (default ${CONFIG_FILES[0]})
  Needs wrangler (npm i -D wrangler) logged in (wrangler login, or CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID).
  The first deploy of an environment makes the app's API key (and events secret) and prints them once.
  In CI, set CONNECTD_ROOT_KEY as a secret. Managed deploys (--managed) wait for the managed service (#34).

connectd keys [ls | create <name> | roll <id|name> | revoke <id|name>]
  --env <name>     the deployment (default dev: CONNECTD_URL in .env); a deployed one by its last deploy's URL
  --url <url>      its URL instead (works outside the project, with CONNECTD_ROOT_KEY in the shell)
  --events         an events signing secret (CONNECTD_EVENTS_SECRET) instead of an API key: create makes one, roll and revoke find one by name
  --grace <time>   roll: how long the old secret keeps working (0, 30m, 24h, 7d; default 0)
  A new secret is shown once; put it where it's used (keys never writes .env). Dev makes the
  app's first dev key itself, into .env, when .env has no working one.

connectd dashboard
  --env <name>, --url <url>   which deployment (as for keys)
  --print          print the sign-in link instead of opening a browser
  The link signs in once, within 5 minutes; the dashboard then offers to make an account (passkey or password).
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
  events: "boolean",
  grace: "string",
  print: "boolean",
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
      const dir = o.dir ?? process.cwd();
      const str = (k: string) => (typeof a.flags[k] === "string" ? (a.flags[k] as string) : undefined);
      const [sub = "ls", which, ...extra] = a.rest;
      try {
        const d = deployment(dir, { ...(str("env") ? { environment: str("env") } : {}), ...(str("url") ? { url: str("url") } : {}) });
        const dev = d.environment === DEV_ENV;
        // Shown, never written anywhere: it goes where it's used (.env, the app host, CI), by you.
        const show = (m: Made, verb: string) =>
          log(`${verb} ${m.info.kind === "events" ? "events secret" : "API key"} ${m.info.name} (${m.info.prefix}) in ${d.environment}. The secret, shown once (put it where it's used):\n\n  ${envLine(m)}\n`);
        if (sub === "ls" && !which) {
          const all = await admin<KeyInfo[]>(d, "GET", "/admin/keys");
          if (!all.length) return log(`no keys in ${d.environment}: connectd keys create <name>${dev ? "" : ` --env ${d.environment}`}`), 0;
          const t = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "—");
          log(
            [
              `${d.environment} (${d.url})`,
              `  ${"ID".padEnd(14)}${"KIND".padEnd(8)}${"NAME".padEnd(18)}${"STATUS".padEnd(10)}${"CREATED".padEnd(18)}LAST USED`,
              ...all.map((k) => `  ${k.id.padEnd(14)}${k.kind.padEnd(8)}${k.name.slice(0, 17).padEnd(18)}${k.status.padEnd(10)}${t(k.createdAt).padEnd(18)}${k.kind === "api" ? t(k.lastUsedAt) : ""}`),
            ].join("\n"),
          );
          return 0;
        }
        if (!which || extra.length) return log(`connectd keys ${sub} <${sub === "create" ? "name" : "id or name"}>`), 2;
        if (sub === "create") {
          show(await admin<Made>(d, "POST", "/admin/keys", { name: which, kind: a.flags.events ? "events" : "api" }), "made");
          return 0;
        }
        if (sub === "roll") {
          const k = await findKey(d, which, a.flags.events ? "events" : "api");
          const graceMs = duration(str("grace") ?? "0");
          show(await admin<Made>(d, "POST", `/admin/keys/${k.id}/roll`, { graceMs }), "rolled");
          log(graceMs ? `the old secret works until ${new Date(Date.now() + graceMs).toISOString()}` : "the old secret stopped working");
          return 0;
        }
        if (sub === "revoke") {
          const k = await findKey(d, which, a.flags.events ? "events" : "api");
          await admin(d, "POST", `/admin/keys/${k.id}/revoke`, {});
          log(`revoked ${k.kind === "events" ? "events secret" : "API key"} ${k.name} (${k.prefix}) in ${d.environment}${k.kind === "api" ? ": calls with it fail within 30 seconds" : ""}`);
          return 0;
        }
        return log(`connectd keys takes ls, create, roll or revoke`), 2;
      } catch (e) {
        log((e as Error).message);
        return 1;
      }
    }
    case "dashboard": {
      const dir = o.dir ?? process.cwd();
      const str = (k: string) => (typeof a.flags[k] === "string" ? (a.flags[k] as string) : undefined);
      try {
        const d = deployment(dir, { ...(str("env") ? { environment: str("env") } : {}), ...(str("url") ? { url: str("url") } : {}) });
        const url = await loginUrl(d);
        if (a.flags.print || !open(url)) log(`sign in to ${d.environment}'s dashboard (works once, within 5 minutes):\n\n  ${url}\n`);
        else log(`opened ${d.url}/dashboard (${d.environment}), signed in`);
        return 0;
      } catch (e) {
        log((e as Error).message);
        return 1;
      }
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

/** Open `url` in the browser; false where there's no desktop to open it on (SSH, CI). */
function open(url: string): boolean {
  if (process.env.CI || process.env.SSH_CONNECTION || process.env.NODE_ENV === "test") return false;
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  try {
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    return true;
  } catch {
    return false;
  }
}
