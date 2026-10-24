import { existsSync, type FSWatcher, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { Handler, Json, Program } from "@connectd/kernel";
import { memory, type Snapshot } from "@connectd/kernel/memory";
import { memoryIndex, type Runtime, runtime } from "@connectd/runtime";
import { appEnv, devKeys, loadEnv, parseEnv, workdir } from "./env.ts";
import { ENV, type Env, options, type Resolved, unconfigured, unconfiguredText } from "./project.ts";
import { findConfig, loadProject } from "./load.ts";
import { tunnel } from "./tunnel.ts";
import { sdkNote } from "./discover.ts";

export const PORT = 8787;

export type DevOptions = {
  /** The project directory (where `oc.config.ts` and `.env` are). */
  dir: string;
  /** Config file, relative to `dir`. Default: the first of CONFIG_FILES that exists. */
  config?: string;
  /** Default 8787; 0 picks a free one. */
  port?: number;
  /** Public URL (`/callback`, `/webhooks`), for a tunnel run elsewhere. Default: `--tunnel`'s, `CONNECTD_PUBLIC_URL`, or localhost. */
  url?: string;
  /** Start a cloudflared quick tunnel; `bin` replaces `cloudflared` (tests). */
  tunnel?: boolean | { bin: string };
  /** Start from empty state (drops `.connectd/state.json`). */
  reset?: boolean;
  /** Default true. */
  watch?: boolean;
  /** The process environment; default `process.env`. */
  env?: Env;
  log?: (line: string) => void;
};

/** What a load produced, for the banner and tests. */
export type Loaded = { project: Resolved; unconfigured: string[]; publicUrl: string };

/**
 * A Program whose instances follow `swap(next)`, the way a deploy restarts isolates: per-isolate
 * memory (single-flight, sync marks) goes, the store stays. An instance moves to the new program only
 * when idle (no call or timer running on it): until then new calls join the old handler, so one
 * instance never has two live handlers (a DO never does, and the events outbox relies on it).
 * ponytail: an instance that's never idle keeps the old code; fine for dev traffic.
 */
export function swappable() {
  let current: Program | undefined;
  let gen = 0;
  const program: Program = (d, id) => {
    let h: Handler | undefined;
    let mine = -1;
    let busy = 0;
    const run = async (f: (h: Handler) => Promise<Json | void>) => {
      if (!h || (mine !== gen && busy === 0)) [h, mine] = [(current as Program)(d, id), gen];
      busy++;
      try {
        return await f(h);
      } finally {
        busy--;
      }
    };
    return { onCall: (m, a) => run((x) => x.onCall(m, a)) as Promise<Json>, onTimer: (n, p) => run((x) => x.onTimer(n, p)) as Promise<void> };
  };
  return { program, swap: (p: Program) => void ((current = p), gen++) };
}

/** Build output, dependencies, hidden folders (.next, .git, .connectd, .turbo), and generated types: saves there never reload. `.env*` does. */
const SKIP = new Set(["node_modules", "dist", "build", "out"]);
export function ignored(path: string) {
  const s = path.split(/[/\\]/);
  const file = s.pop() ?? "";
  return s.some((x) => x.startsWith(".") || SKIP.has(x)) || SKIP.has(file) || (file.startsWith(".") && !file.startsWith(".env")) || /\.(d\.ts|tsbuildinfo|log)$/.test(file);
}

/**
 * A `(Request) => Response` handler on node:http (Node and Bun both have it), on localhost. `port` 0
 * picks a free one.
 */
const IGNORED = /(^|[/\\])(node_modules|\.connectd|\.git)([/\\]|$)/;

const HOP = ["connection", "keep-alive", "transfer-encoding", "te", "upgrade", "proxy-connection"];

export async function serve(port: number, handle: (req: Request) => Promise<Response>) {
  const run = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Uint8Array[] = [];
    for await (const c of req) chunks.push(c as Uint8Array);
    const headers = new Headers();
    // Hop-by-hop headers describe the connection to this server, not the request (Node's fetch refuses some).
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.includes(k)) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const method = req.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks);
    // The runtime reads only the path and query; its public URL comes from settings.
    const out = await handle(new Request(new URL(req.url ?? "/", `http://localhost:${bound}`).href, { method, headers, ...(body ? { body } : {}) }));
    const head: Record<string, string | string[]> = {};
    out.headers.forEach((v, k) => void (k === "set-cookie" ? 0 : (head[k] = v)));
    const cookies = out.headers.getSetCookie();
    if (cookies.length) head["set-cookie"] = cookies;
    if (out.statusText) res.writeHead(out.status, out.statusText, head);
    else res.writeHead(out.status, head);
    if (!out.body || method === "HEAD") return void res.end();
    // Streamed, as the proxy streams the provider's response (SSE, downloads).
    // pipeline: an upstream that fails partway resets the client's connection, a client that goes away stops the upstream.
    await pipeline(Readable.fromWeb(out.body as NodeReadableStream), res).catch(() => {});
  };
  const server = createServer((req, res) =>
    run(req, res).catch((e) => {
      console.error("connectd dev:", e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }),
  );
  await new Promise<void>((ok, fail) => server.once("error", fail).listen(port, "localhost", ok));
  const bound = (server.address() as AddressInfo).port;
  return {
    port: bound,
    stop: () => {
      server.closeAllConnections();
      return new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

/**
 * `connectd dev`: the runtime on the memory driver with a real clock, on node:http. State
 * (connections, handshakes, outboxes, timers) is snapshotted to `.connectd/state.json`, so it
 * survives restarts; a change to the config or anything it imports reloads the definitions in
 * place, keeping state, as a deploy would.
 */
export async function dev(o: DevOptions) {
  const log = o.log ?? console.log;
  const dir = resolvePath(o.dir);
  const entry = findConfig(dir, o.config);
  const work = workdir(dir);
  const statePath = join(work, "state.json");
  const build = join(work, "build");
  rmSync(build, { recursive: true, force: true });
  if (o.reset) rmSync(statePath, { force: true });
  const keys = devKeys(dir);
  let snapshot: Snapshot | undefined;
  try {
    snapshot = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as Snapshot) : undefined;
  } catch {
    throw new Error(`${statePath} is unreadable; --reset starts empty`);
  }

  const hot = swappable();
  let rt: Runtime | undefined;
  const index = memoryIndex();
  let w: ReturnType<typeof memory> | undefined;

  const server = await serve(o.port ?? PORT, async (req) => {
      const t = performance.now();
      const res =
        rt && w
          ? await rt.fetch(req, w.call)
          : Response.json({ error: { code: "not_ready", status: 503, message: "the config failed to load; see the dev server's output" } }, { status: 503 });
      // The path only: queries carry codes and states.
      log(`${req.method} ${new URL(req.url).pathname} ${res.status} ${Math.round(performance.now() - t)}ms`);
      return res;
  });
  const local = `http://localhost:${server.port}`;
  let tun: { url: string; stop(): void } | undefined;
  try {
    if (o.tunnel) tun = await tunnel(server.port, typeof o.tunnel === "object" ? o.tunnel : {});
  } catch (e) {
    server.stop();
    throw e;
  }

  let n = 0;
  let loaded: Loaded | undefined;
  /** What the last good load read: its files' directories, and the connection folders' parent (new folders). */
  let watched: { folders: string | null; dirs: Set<string> } | undefined;
  /** Build, import and validate; swap only if all of it worked. */
  async function load(): Promise<Loaded> {
    const env = loadEnv(dir, keys.keys, o.env);
    const { config, folders, inputs } = await loadProject(dir, entry, build, ++n, env);
    watched = { folders, dirs: new Set([dir, ...[...inputs].filter((f) => !IGNORED.test(f)).map(dirname)]) };
    const publicUrl = (o.url ?? tun?.url ?? env[ENV.url] ?? local).replace(/\/+$/, "");
    if (!/^https?:\/\/[^/]+/.test(publicUrl)) throw new Error(`public URL ${publicUrl} is not an http(s) URL`);
    // options() keeps only what the project reads, as deployed: a connection that works here works there.
    const opts = options(config, { ...env, [ENV.url]: publicUrl }, index);
    await opts.settings(); // missing keys or a bad one fail here, not on the first request
    const next = runtime({ ...opts, now: () => (w as ReturnType<typeof memory>).now() });
    rt = next;
    hot.swap(next.program);
    if (!w) {
      w = memory(hot.program, { clock: Date.now, ...(snapshot ? { snapshot } : {}) });
      // The index isn't in the snapshot: rebuild it from each connection (the #26 repair path).
      for (const id of Object.keys(snapshot ?? {})) if (id.startsWith("conn:")) await w.call(id, "index.sync", null);
    }
    return (loaded = { project: opts.project, unconfigured: unconfigured(opts.project), publicUrl });
  }

  async function reload() {
    const t = performance.now();
    try {
      const l = await load();
      log(`reloaded: ${l.project.definitions.map((d) => d.id).join(", ") || "no definitions"} (${Math.round(performance.now() - t)}ms)`);
      return true;
    } catch (e) {
      log(`reload failed, still serving the previous version:\n${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  let saved = snapshot ? JSON.stringify(snapshot) : "";
  function save() {
    if (!w) return;
    const s = JSON.stringify(w.dump());
    if (s === saved) return;
    // Credentials in it are sealed, but handshakes and outboxes aren't: owner only, like dev.vars.
    rmSync(`${statePath}.tmp`, { force: true }); // mode applies only to a new file
    writeFileSync(`${statePath}.tmp`, s, { mode: 0o600 });
    renameSync(`${statePath}.tmp`, statePath);
    saved = s;
  }
  // ponytail: polled, so a hard kill loses up to the last half second of writes; hook the store's writes if that bites.
  const saver = setInterval(save, 500);

  try {
    await load();
  } catch (e) {
    log(`config failed to load (fix it and save; serving 503 until then):\n${e instanceof Error ? e.message : String(e)}`);
  }

  // The app's side: its runtime URL and the two keys it shares with the runtime, into .env.
  {
    const env = loadEnv(dir, keys.keys, o.env);
    const url = loaded?.publicUrl ?? local;
    const wrote = appEnv(dir, { CONNECTD_URL: url, [ENV.apiKey]: env[ENV.apiKey] ?? "", [ENV.events]: env[ENV.events] ?? "" });
    if (wrote.length) log(`wrote ${wrote.join(", ")} to .env for your app`);
    const set = parseEnv(existsSync(join(dir, ".env")) ? readFileSync(join(dir, ".env"), "utf8") : "").CONNECTD_URL;
    if (set && set !== url) log(`note: .env has CONNECTD_URL=${set}, but this dev server is ${url}`);
  }

  let watchers: FSWatcher[] = [];
  if (o.watch !== false) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = Promise.resolve();
    const changed = (_: unknown, f: string | Buffer | null) => {
      if (ignored(String(f ?? ""))) return;
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          (running = running.then(async () => {
            if (stopping) return;
            await reload();
            arm();
          })),
        50,
      );
    };
    // The directories of the files the config bundles (not node_modules: a recursive watch walks
    // the whole tree, on every arm), and the connection folders recursively, armed again after each
    // reload: the files may have changed, and on Linux, Node's recursive watcher loses a file that an
    // editor saved by renaming a new one over it (vim, sed -i). Until a load works, the project.
    const arm = () => {
      for (const x of watchers) x.close();
      const on = (p: string, recursive: boolean) => {
        try {
          return [watch(p, { recursive }, changed)];
        } catch {
          return []; // gone since (a deleted folder)
        }
      };
      watchers = watched
        ? [...[...watched.dirs].flatMap((d) => on(d, false)), ...(watched.folders && existsSync(watched.folders) ? on(watched.folders, true) : [])]
        : on(dir, true);
    };
    arm();
  }

  let stopping: Promise<void> | undefined;
  const info = {
    url: local,
    port: server.port,
    apiKey: loadEnv(dir, keys.keys, o.env)[ENV.apiKey] as string,
    created: keys.created,
    statePath,
    loaded: () => loaded,
    reload,
    save,
    /** The memory driver (tests advance its clock to drive retries). */
    driver: () => w,
    /** Idempotent (SIGINT twice, a test's cleanup after its own stop). */
    stop: () =>
      (stopping ??= (async () => {
        for (const x of watchers) x.close();
        clearInterval(saver);
        await server.stop();
        await w?.stop();
        save();
        tun?.stop();
      })()),
  };
  log(banner(info));
  const note = sdkNote(dir);
  if (note) log(note);
  return info;
}

export type Dev = Awaited<ReturnType<typeof dev>>;

export function banner(d: Pick<Dev, "url" | "apiKey" | "created" | "statePath" | "loaded">) {
  const l = d.loaded();
  const rows: [string, string][] = [
    ["URL", d.url],
    ["API key", `${d.apiKey}${d.created ? "   (new: generated into .connectd/dev.vars)" : ""}`],
  ];
  if (l) {
    const pub = l.publicUrl;
    rows.push(["public URL", pub === d.url ? `${pub}   (https-only providers like Slack need --tunnel or --url)` : pub]);
    rows.push(["callback URL", `${pub}/callback   (register this redirect URI with each OAuth provider)`]);
    rows.push(["webhooks", `${pub}/webhooks/:def[/:id]`]);
    rows.push(["events", l.project.events ? `${l.project.events.url}   (your app verifies with ${ENV.events}, in .env)` : "off (set events: { url } in the config)"]);
    rows.push(["sessions", l.project.sessions ? l.project.sessions.origins.join(", ") || "no origins" : "off (set sessions: { origins } in the config)"]);
    rows.push(["dashboard", l.project.dashboard === false ? "off (dashboard: false in the config)" : `${d.url}/dashboard   (sign in with the API key)`]);
    rows.push(["definitions", l.project.definitions.map((x) => x.id).join(", ") || "none"]);
    if (l.unconfigured.length) rows.push(["no config", `${unconfiguredText(l.project).join(", ")}   (answer not_configured until .env has them)`]);
    if (l.project.envNames.length) rows.push(["env", `${l.project.envNames.join(", ")}   (from .env; nothing else reaches the runtime)`]);
  }
  rows.push(["state", `${d.statePath}   (--reset to start empty)`]);
  return `\nconnectd dev\n${rows.map(([k, v]) => `  ${k.padEnd(14)}${v}`).join("\n")}\n`;
}
