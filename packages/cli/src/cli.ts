import { parse } from "./args.ts";
import { dev, PORT } from "./dev.ts";
import { join } from "node:path";
import { deploy } from "./deploy.ts";
import { workdir } from "./env.ts";
import { CONFIG_FILES, findConfig, importConfig } from "./load.ts";

export const HELP = `openconnect <command> [flags]

Commands
  dev       run the runtime locally: in memory, real clock, state kept in .openconnect/, reloads on save
  deploy    deploy to your Cloudflare account (through wrangler)
  help      this text

openconnect dev
  --port <n>       port (default ${PORT}; 0 picks a free one)
  --config <file>  config file (default ${CONFIG_FILES[0]})
  --tunnel         expose it on a public https URL with a cloudflared quick tunnel (Slack needs https)
  --url <url>      public URL of a tunnel you run yourself (callback and webhook URLs use it)
  --reset          start from empty state

openconnect deploy
  --env-file <f>   provider secrets to push as Worker secrets (e.g. .prod.vars; never .openconnect/dev.vars)
  --name <name>    Worker name (default: deploy.name in the config, else the directory's name)
  --url <url>      public https origin on a custom domain (default: the workers.dev URL)
  --rotate <list>  comma-separated: key (adds OPENCONNECT_KEY_V<n+1>), api-key, state, sessions
  --new-keys       generate fresh runtime keys although the index database exists without its Worker
  --dry-run        write .openconnect/deploy/ (entry, wrangler.json, migrations) and print the plan; no Cloudflare calls
  --config <file>  config file (default ${CONFIG_FILES[0]})
  Needs wrangler (bun add -d wrangler) logged in (wrangler login, or CLOUDFLARE_API_TOKEN).
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
        await deploy({
          dir,
          config,
          load: () => importConfig(config, join(workdir(dir), "build"), Date.now()),
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
    default:
      return log(`unknown command ${a.command}\n\n${HELP}`), 2;
  }
}
