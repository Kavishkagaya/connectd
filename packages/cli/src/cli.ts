import { parse } from "./args.ts";
import { APP_PORT, dev, PORT } from "./dev.ts";
import { join } from "node:path";
import { deploy } from "./deploy.ts";
import { workdir } from "./env.ts";
import { CONFIG_FILES, findConfig, loadProject } from "./load.ts";
import { sdkNote } from "./discover.ts";
import { ENV, generateKeys } from "./keys.ts";

export const HELP = `connectd <command> [flags] [-- app command]

Commands
  dev       run the runtime locally: in memory, real clock, state kept in .connectd/, reloads on save
  deploy    deploy to your Cloudflare account (through wrangler)
  types     write .connectd/registry.d.ts (the typed client's registry; dev and deploy write it too)
  keys      print a new CONNECTD_API_KEY and CONNECTD_EVENTS_SECRET (for CI secrets and your app's host)
  help      this text

connectd dev
  --port <n>       port (default ${PORT}; 0 picks a free one)
  --config <file>  config file (default ${CONFIG_FILES[0]})
  --tunnel         expose it on a public https URL with a cloudflared quick tunnel (Slack needs https)
  --url <url>      public URL of a tunnel you run yourself (callback and webhook URLs use it)
  --reset          start from empty state
  --app-port <n>   your app's port (default 3000): APP_URL=http://localhost:<n> for the config and the app
  -- <command>     also run your app (connectd dev -- next dev), with PORT, APP_URL, CONNECTD_URL,
                   CONNECTD_API_KEY and CONNECTD_EVENTS_SECRET set; stops with dev

connectd deploy
  --env-file <f>   the production env (default .env.production; in CI, CI=true, the shell's); only names the project reads are pushed
  --name <name>    Worker name (default: the target's name, cloudflare({ name }), else the directory's name)
  --url <url>      public https origin on a custom domain (default: the workers.dev URL)
  --rotate <list>  comma-separated: key (adds CONNECTD_KEY_V<n+1>), api-key, state, sessions
  --new-keys       generate fresh runtime keys although the index database exists without its Worker
  --dry-run        write .connectd/deploy/ (entry, wrangler.json, migrations) and print the plan; no Cloudflare calls
  --config <file>  config file (default ${CONFIG_FILES[0]})
  Needs wrangler (bun add -d wrangler) logged in (wrangler login, or CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID).
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
  "app-port": "string",
  "env-file": "string",
  name: "string",
  rotate: "string",
  "dry-run": "boolean",
  "new-keys": "boolean",
  managed: "boolean",
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
    case "dev": {
      const port = a.flags.port === undefined ? undefined : Number(a.flags.port);
      if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536)) return log(`--port must be a port number`), 2;
      const appPort = a.flags["app-port"] === undefined ? undefined : Number(a.flags["app-port"]);
      if (appPort !== undefined && !(Number.isInteger(appPort) && appPort > 0 && appPort < 65536)) return log(`--app-port must be a port number`), 2;
      try {
        const d = await dev({
          dir: o.dir ?? process.cwd(),
          ...(port !== undefined ? { port } : {}),
          ...(typeof a.flags.config === "string" ? { config: a.flags.config } : {}),
          ...(typeof a.flags.url === "string" ? { url: a.flags.url } : {}),
          ...(a.flags.tunnel ? { tunnel: true } : {}),
          ...(a.flags.reset ? { reset: true } : {}),
          ...(a.after.length || appPort ? { app: { command: a.after, port: appPort ?? APP_PORT } } : {}),
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
        await deploy({
          dir,
          load: (env) => loadProject(dir, config, join(workdir(dir), "build"), Date.now(), env),
          ...(name ? { name } : {}),
          ...(url ? { url } : {}),
          ...(envFile ? { envFile } : {}),
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
        const { found } = await loadProject(dir, config, join(workdir(dir), "build"), Date.now(), { ...process.env });
        log(`wrote .connectd/registry.d.ts and app.ts (${found.length ? found.map((f) => `${f.id}${f.actions.length ? ` (${f.actions.map((a) => a.name).join(", ")})` : ""}`).join(", ") : "no connection folders"})`);
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
