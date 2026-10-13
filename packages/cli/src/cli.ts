import { parse } from "./args.ts";
import { CONFIG_FILES, dev, PORT } from "./dev.ts";

export const HELP = `openconnect <command> [flags]

Commands
  dev       run the runtime locally: in memory, real clock, state kept in .openconnect/, reloads on save
  deploy    deploy to Cloudflare (coming in #31)
  help      this text

openconnect dev
  --port <n>       port (default ${PORT}; 0 picks a free one)
  --config <file>  config file (default ${CONFIG_FILES[0]})
  --tunnel         expose it on a public https URL with a cloudflared quick tunnel (Slack needs https)
  --url <url>      public URL of a tunnel you run yourself (callback and webhook URLs use it)
  --reset          start from empty state
`;

const SPEC = { help: "boolean", port: "string", config: "string", tunnel: "boolean", url: "string", reset: "boolean" } as const;

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
    case "deploy":
      return log("openconnect deploy isn't here yet (#31)."), 1;
    default:
      return log(`unknown command ${a.command}\n\n${HELP}`), 2;
  }
}
