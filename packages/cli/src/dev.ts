import { existsSync, type FSWatcher, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { Handler, Json, Program } from "@openconnect/kernel";
import { memory, type Snapshot } from "@openconnect/kernel/memory";
import { memoryIndex, type Runtime, runtime } from "@openconnect/runtime";
import { devKeys, loadEnv, workdir } from "./env.ts";
import { ENV, type Env, options, type Project, unconfigured } from "./project.ts";
import { findConfig, loadProject } from "./load.ts";
import { tunnel } from "./tunnel.ts";

export const PORT = 8787;

export type DevOptions = {
  /** The project directory (where `openconnect.config.ts` and `.dev.vars` are). */
  dir: string;
  /** Config file, relative to `dir`. Default: the first of CONFIG_FILES that exists. */
  config?: string;
  /** Default 8787; 0 picks a free one. */
  port?: number;
  /** Public URL (`/callback`, `/webhooks`), for a tunnel run elsewhere. Default: `--tunnel`'s, `OPENCONNECT_PUBLIC_URL`, or localhost. */
  url?: string;
  /** Start a cloudflared quick tunnel; `bin` replaces `cloudflared` (tests). */
  tunnel?: boolean | { bin: string };
  /** Start from empty state (drops `.openconnect/state.json`). */
  reset?: boolean;
  /** Default true. */
  watch?: boolean;
  /** The process environment; default `process.env`. */
  env?: Env;
  log?: (line: string) => void;
};

/** What a load produced, for the banner and tests. */
export type Loaded = { project: Project; unconfigured: string[]; publicUrl: string };

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

/**
 * `openconnect dev`: the runtime on the memory driver with a real clock, served by Bun. State
 * (connections, handshakes, outboxes, timers) is snapshotted to `.openconnect/state.json`, so it
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

  const server = Bun.serve({
    port: o.port ?? PORT,
    hostname: "localhost",
    idleTimeout: 120,
    async fetch(req) {
      const t = performance.now();
      const res =
        rt && w
          ? await rt.fetch(req, w.call)
          : Response.json({ error: { code: "not_ready", status: 503, message: "the config failed to load; see the dev server's output" } }, { status: 503 });
      // The path only: queries carry codes and states.
      log(`${req.method} ${new URL(req.url).pathname} ${res.status} ${Math.round(performance.now() - t)}ms`);
      return res;
    },
  });
  const local = `http://localhost:${server.port}`;
  let tun: { url: string; stop(): void } | undefined;
  try {
    if (o.tunnel) tun = await tunnel(server.port as number, typeof o.tunnel === "object" ? o.tunnel : {});
  } catch (e) {
    server.stop(true);
    throw e;
  }

  let n = 0;
  let loaded: Loaded | undefined;
  /** Build, import and validate; swap only if all of it worked. */
  async function load(): Promise<Loaded> {
    const env = loadEnv(dir, keys.keys, o.env);
    const { config } = await loadProject(dir, entry, build, ++n, env);
    const publicUrl = (o.url ?? tun?.url ?? env[ENV.url] ?? local).replace(/\/+$/, "");
    if (!/^https?:\/\/[^/]+/.test(publicUrl)) throw new Error(`public URL ${publicUrl} is not an http(s) URL`);
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

  let watcher: FSWatcher | undefined;
  if (o.watch !== false) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = Promise.resolve();
    watcher = watch(dir, { recursive: true }, (_, f) => {
      const p = String(f ?? "");
      if (/(^|[/\\])(node_modules|\.openconnect|\.git)([/\\]|$)/.test(p)) return;
      clearTimeout(timer);
      timer = setTimeout(() => (running = running.then(async () => void (await reload()))), 50);
    });
  }

  let stopping: Promise<void> | undefined;
  const info = {
    url: local,
    port: server.port as number,
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
        watcher?.close();
        clearInterval(saver);
        await server.stop(true);
        await w?.stop();
        save();
        tun?.stop();
      })()),
  };
  log(banner(info));
  return info;
}

export type Dev = Awaited<ReturnType<typeof dev>>;

export function banner(d: Pick<Dev, "url" | "apiKey" | "created" | "statePath" | "loaded">) {
  const l = d.loaded();
  const rows: [string, string][] = [
    ["URL", d.url],
    ["API key", `${d.apiKey}${d.created ? "   (new: generated into .openconnect/dev.vars)" : ""}`],
  ];
  if (l) {
    const pub = l.publicUrl;
    rows.push(["public URL", pub === d.url ? `${pub}   (https-only providers like Slack need --tunnel or --url)` : pub]);
    rows.push(["callback URL", `${pub}/callback   (register this redirect URI with each OAuth provider)`]);
    rows.push(["webhooks", `${pub}/webhooks/:def[/:id]`]);
    rows.push(["events", l.project.events ? `${l.project.events.url}   (verify with ${ENV.events} from .openconnect/dev.vars)` : "off (set events: { url } in the config)"]);
    rows.push(["sessions", l.project.sessions ? l.project.sessions.origins.join(", ") || "no origins" : "off (set sessions: { origins } in the config)"]);
    rows.push(["dashboard", l.project.dashboard === false ? "off (dashboard: false in the config)" : `${d.url}/dashboard   (sign in with the API key)`]);
    rows.push(["definitions", l.project.definitions.map((x) => x.id).join(", ") || "none"]);
    if (l.unconfigured.length) rows.push(["no config", `${l.unconfigured.join(", ")}   (answer not_configured until config: { <id>: ... } is set)`]);
  }
  rows.push(["state", `${d.statePath}   (--reset to start empty)`]);
  return `\nopenconnect dev\n${rows.map(([k, v]) => `  ${k.padEnd(14)}${v}`).join("\n")}\n`;
}
