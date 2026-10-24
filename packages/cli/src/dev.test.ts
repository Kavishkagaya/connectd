import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Overview } from "@connectd/dashboard";
import { type ConnectionEvent, connectd } from "@connectd/sdk";
import { main } from "./cli.ts";
import { type Dev, dev, ignored, serve, swappable } from "./dev.ts";
import type { Program } from "@connectd/kernel";
import { memory } from "@connectd/kernel/memory";
import { parseEnv } from "./env.ts";
import { NO_CLOUDFLARED, tunnel, tunnelUrl } from "./tunnel.ts";

// Projects live under packages/cli/.tmp so their imports resolve through this package's node_modules.
const TMP = join(import.meta.dir, "..", ".tmp");
mkdirSync(TMP, { recursive: true });
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const running: Dev[] = [];
const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.stop();
  for (const s of servers.splice(0)) s.stop(true);
});

const until = async <T>(f: () => T | Promise<T>, ms = 3000): Promise<NonNullable<T>> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

const CONFIG = `
import { apiKey, defineConnection, oauth2 } from "@connectd/connections";
import { label } from "./label.ts";

export default (env) => ({
  definitions: [
    defineConnection({
      id: "example",
      auth: oauth2({ authorizeUrl: env.PROVIDER + "/authorize", tokenUrl: env.PROVIDER + "/token" }),
      async metadata(ctx, cred) {
        const r = await ctx.fetch(env.PROVIDER + "/me", { headers: { authorization: "Bearer " + cred.accessToken } });
        return { login: (await r.json()).login, label };
      },
      external: (m) => ({ login: m.login }),
      proxy: { baseUrl: env.UPSTREAM },
    }),
    defineConnection({ id: "keyed", auth: apiKey(["key"]), proxy: { baseUrl: env.UPSTREAM, inject: { query: "api_key" } } }),
  ],
  config: env.CLIENT_ID ? { example: { clientId: env.CLIENT_ID, clientSecret: "cs" } } : {},
  ...(env.EVENTS ? { events: { url: env.EVENTS } } : {}),
});
`;

function project(files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(TMP, "p-"));
  for (const [f, s] of Object.entries({ "oc.config.ts": CONFIG, "label.ts": `export const label = "v1";\n`, ".env": "CLIENT_ID=cid\n", ...files }))
    mkdirSync(join(dir, f, ".."), { recursive: true }), writeFileSync(join(dir, f), s);
  return dir;
}

/** A provider (token + userinfo), an upstream API, and an events receiver: local servers on free ports. */
function world() {
  const serve = (fetch: (req: Request) => Response | Promise<Response>) => {
    const s = Bun.serve({ port: 0, hostname: "localhost", fetch });
    servers.push(s);
    return `http://localhost:${s.port}`;
  };
  const upstream: Request[] = [];
  let receiver: (req: Request) => Response | Promise<Response> = () => new Response(null, { status: 204 });
  const provider = serve(async (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/token") return Response.json({ access_token: "a1", refresh_token: "r1", expires_in: 3600 });
    if (u.pathname === "/me") return Response.json({ login: "octo" });
    return new Response("not found", { status: 404 });
  });
  const api = serve((req) => (upstream.push(req), Response.json({ path: new URL(req.url).pathname, auth: req.headers.get("authorization") })));
  const events = serve((req) => receiver(req));
  return { env: { PROVIDER: provider, UPSTREAM: api, EVENTS: `${events}/events` }, upstream, receive: (f: typeof receiver) => void (receiver = f) };
}

async function start(dir: string, env: Record<string, string>, o: { watch?: boolean; reset?: boolean } = {}) {
  const lines: string[] = [];
  const d = await dev({ dir, port: 0, env, watch: o.watch ?? false, log: (l) => void lines.push(l), ...(o.reset ? { reset: true } : {}) });
  running.push(d);
  return { d, lines, oc: connectd({ url: d.url, apiKey: d.apiKey }) };
}

/** connect, the user approving at the provider, and the provider redirecting back to /callback. */
async function authorize(d: Dev, oc: ReturnType<typeof connectd>, id: string) {
  const { url } = await oc.connection("example", id).connect();
  const state = new URL(url as string).searchParams.get("state") as string;
  const res = await fetch(`${d.url}/callback?code=c1&state=${encodeURIComponent(state)}`);
  expect(res.status).toBe(200);
}

test("keys: generated once into .connectd/dev.vars, gitignored, kept across runs", async () => {
  const w = world();
  const dir = project();
  const a = await start(dir, w.env);
  expect(a.d.created).toBe(true);
  expect(a.d.apiKey).toMatch(/^oc_[A-Za-z0-9]{32}$/);
  expect(a.lines.join("\n")).toContain(a.d.apiKey);
  const vars = parseEnv(readFileSync(join(dir, ".connectd", "dev.vars"), "utf8"));
  expect(Object.keys(vars).sort()).toEqual(
    ["CONNECTD_API_KEY", "CONNECTD_EVENTS_SECRET", "CONNECTD_KEY_V1", "CONNECTD_SESSIONS_KEY", "CONNECTD_STATE_KEY", "CONNECTD_WEBHOOKS_KEY"].sort(),
  );
  expect(vars.CONNECTD_EVENTS_SECRET).toStartWith("whsec_");
  expect(readFileSync(join(dir, ".connectd", ".gitignore"), "utf8")).toBe("*\n");
  await a.d.stop();
  const b = await start(dir, w.env);
  expect(b.d.created).toBe(false);
  expect(b.d.apiKey).toBe(a.d.apiKey);
  // The project's own env wins over generated keys.
  writeFileSync(join(dir, ".env"), "CLIENT_ID=cid\nCONNECTD_API_KEY=mine\n");
  await b.d.stop();
  expect((await start(dir, w.env)).d.apiKey).toBe("mine");
});

test("config: function of the env (.env < process env), banner, unconfigured definitions", async () => {
  const w = world();
  const dir = project({ ".env": "" });
  const { d, lines } = await start(dir, w.env);
  const l = d.loaded()!;
  expect(l.project.definitions.map((x) => x.id)).toEqual(["example", "keyed"]);
  // CLIENT_ID unset: example has no config; keyed is an API-key definition and needs none.
  expect(l.unconfigured).toEqual(["example"]);
  expect(l.publicUrl).toBe(d.url);
  const out = lines.join("\n");
  expect(out).toContain(`${d.url}/callback`);
  expect(out).toContain("example, keyed");
  expect(out).toContain(`${w.env.EVENTS}`);
  expect(out).toContain(`${d.url}/dashboard`);
  // The dashboard is on by default: the page is public, its API needs the key.
  expect((await fetch(`${d.url}/dashboard`)).headers.get("content-security-policy")).toContain("script-src 'self'");
  expect((await fetch(`${d.url}/dashboard/api/overview`)).status).toBe(401);
  const ov = (await (await fetch(`${d.url}/dashboard/api/overview`, { headers: { authorization: `Bearer ${d.apiKey}` } })).json()) as Overview;
  expect(ov.definitions.map((x) => [x.id, x.configured])).toEqual([
    ["example", false],
    ["keyed", true],
  ]);
  const oc = connectd({ url: d.url, apiKey: d.apiKey });
  await expect(oc.connection("example", "u1").connect()).rejects.toMatchObject({ code: "not_configured" });
  await d.stop();
  const again = await start(dir, { ...w.env, CLIENT_ID: "cid", CONNECTD_PUBLIC_URL: "https://dev.example.com/" });
  expect(again.d.loaded()!.unconfigured).toEqual([]);
  expect(again.d.loaded()!.publicUrl).toBe("https://dev.example.com");
  const { url } = await again.oc.connection("example", "u1").connect();
  expect(new URL(url!).searchParams.get("redirect_uri")).toBe("https://dev.example.com/callback");
});

test("one .env: a connection reads its config with env(); only the names read reach the runtime; .dev.vars is refused", async () => {
  const w = world();
  const conn = `import { connection } from "@connectd/connections";
export default connection().config((env) => ({ clientId: env("TRACKER_ID"), region: env.optional("TRACKER_REGION") ?? "us" })).auth((f) => f.apiKey("key"))
  .identity(async (ctx) => ({ config: ctx.config }));`;
  const dir = project({ ".env": "TRACKER_ID=t1\nDATABASE_URL=postgres://app\n", "oc/tracker/connection.ts": conn });
  const { d, oc } = await start(dir, w.env);
  const l = d.loaded()!;
  expect(l.project.envNames).toContain("TRACKER_ID");
  expect(l.project.envNames).toContain("TRACKER_REGION");
  expect(l.project.envNames).not.toContain("DATABASE_URL");
  expect(l.project.config?.tracker).toEqual({ clientId: "t1", region: "us" });
  await oc.connection("tracker", "u1").connect({ key: "k" });
  expect((await oc.connection("tracker", "u1").status()).metadata).toMatchObject({ config: { clientId: "t1", region: "us" } });
  await d.stop();
  // A required name missing: not configured, and the banner names it.
  writeFileSync(join(dir, ".env"), "DATABASE_URL=postgres://app\n");
  const again = await start(dir, w.env);
  expect(again.d.loaded()!.unconfigured).toEqual(["example", "tracker"]);
  expect(again.lines.join("\n")).toContain("tracker (TRACKER_ID)");
  await again.d.stop();
  writeFileSync(join(dir, ".dev.vars"), "CLIENT_ID=cid\n");
  await expect(start(dir, w.env)).rejects.toThrow(".dev.vars isn't read any more");
  // A connection that reads its config can't also get one from oc.config.ts.
  const both = project({ "oc/tracker/connection.ts": conn, "oc.config.ts": `export default { config: { tracker: {} } };` });
  const b = await start(both, w.env);
  expect(b.lines.join("\n")).toContain("remove config.tracker");
});

test("config errors: no config file, duplicate ids, a broken config serves 503 until fixed", async () => {
  const w = world();
  await expect(dev({ dir: mkdtempSync(join(TMP, "e-")), port: 0, watch: false, log: () => {} })).rejects.toThrow(/no oc.config.ts/);
  const dir = project({ "oc.config.ts": `import { apiKey, defineConnection } from "@connectd/connections";
const k = defineConnection({ id: "k", auth: apiKey(["key"]) });
export default { definitions: [k, k] };` });
  const { d, lines } = await start(dir, w.env);
  expect(lines.join("\n")).toContain("two definitions with id k");
  expect((await fetch(`${d.url}/connections/k/a`)).status).toBe(503);
  writeFileSync(join(dir, "oc.config.ts"), CONFIG);
  expect(await d.reload()).toBe(true);
  expect((await fetch(`${d.url}/connections/keyed/a`, { headers: { authorization: `Bearer ${d.apiKey}` } })).status).toBe(404);
});

test("dev server through the SDK: oauth2 and API-key connect, list, proxy, signed events", async () => {
  const w = world();
  const dir = project();
  const { d, oc } = await start(dir, w.env);
  const secret = parseEnv(readFileSync(join(dir, ".connectd", "dev.vars"), "utf8")).CONNECTD_EVENTS_SECRET!;
  const got: ConnectionEvent[] = [];
  const ev = oc.events({ secret }).on("*", (e) => void got.push(e));
  w.receive((req) => ev.handle(req));

  await authorize(d, oc, "u1");
  expect(await oc.connection("example", "u1").status()).toMatchObject({ state: "active", metadata: { login: "octo", label: "v1" } });
  expect(await oc.connection("keyed", "k1").connect({ key: "sekret" })).toEqual({ url: null });

  const rows = [];
  for await (const r of oc.connections.list()) rows.push([r.def, r.id, r.state, r.external]);
  expect(rows).toEqual([
    ["example", "u1", "active", { login: "octo" }],
    ["keyed", "k1", "active", {}],
  ]);

  const res = await oc.connection("example", "u1").fetch("/v1/things");
  expect(await res.json()).toEqual({ path: "/v1/things", auth: "Bearer a1" });
  await oc.connection("keyed", "k1").fetch("/x");
  expect(new URL(w.upstream.at(-1)!.url).searchParams.get("api_key")).toBe("sekret");

  // Delivered by the real-clock timers, verified by the SDK's handler.
  await until(() => got.length >= 3);
  expect(got.map((e) => [e.type, e.connection.definition, e.connection.id])).toEqual([
    ["connection.pending", "example", "u1"],
    ["connection.active", "example", "u1"],
    ["connection.active", "keyed", "k1"],
  ]);
});

test("hot reload: a changed import swaps definitions in place, connections stay; the watcher picks up saves", async () => {
  const w = world();
  const dir = project();
  const { d, oc, lines } = await start(dir, w.env, { watch: true });
  await authorize(d, oc, "u1");
  writeFileSync(join(dir, "label.ts"), `export const label = "v2";\n`);
  await until(() => lines.some((l) => l.startsWith("reloaded: example, keyed")));
  // Old connection: still active, its token still unseals; new code runs for new connections.
  expect(await oc.connection("example", "u1").status()).toMatchObject({ state: "active", metadata: { label: "v1" } });
  expect((await oc.connection("example", "u1").token()) as unknown).toMatchObject({ accessToken: "a1" });
  await authorize(d, oc, "u2");
  expect(await oc.connection("example", "u2").status()).toMatchObject({ metadata: { label: "v2" } });

  // A broken save keeps serving the previous version.
  writeFileSync(join(dir, "label.ts"), `export const label = ;\n`);
  expect(await d.reload()).toBe(false);
  expect(lines.at(-1)).toContain("reload failed, still serving the previous version");
  expect(await oc.connection("example", "u2").status()).toMatchObject({ state: "active" });
});

test("restart: connections, the index and the keys survive; --reset starts empty", async () => {
  const w = world();
  const dir = project();
  const a = await start(dir, w.env);
  await authorize(a.d, a.oc, "u1");
  await a.oc.connection("keyed", "k1").connect({ key: "sekret" });
  await a.d.stop();
  expect(existsSync(join(dir, ".connectd", "state.json"))).toBe(true);

  const b = await start(dir, w.env);
  expect(await b.oc.connection("example", "u1").status()).toMatchObject({ state: "active", metadata: { login: "octo" } });
  expect((await b.oc.connection("example", "u1").token()) as unknown).toMatchObject({ accessToken: "a1" });
  expect((await b.oc.connections.page({})).connections.map((r) => r.id)).toEqual(["u1", "k1"]);
  await b.d.stop();

  const c = await start(dir, w.env, { reset: true });
  await expect(c.oc.connection("example", "u1").status()).rejects.toMatchObject({ code: "not_found" });
  expect((await c.oc.connections.page({})).connections).toEqual([]);
});

test("tunnel: URL parsed from cloudflared's output, missing binary explained", async () => {
  expect(tunnelUrl("2026-10-13T00:00:00Z INF |  https://quiet-river-1a2b.trycloudflare.com  |")).toBe("https://quiet-river-1a2b.trycloudflare.com");
  expect(tunnelUrl("INF Requesting new quick Tunnel on trycloudflare.com...")).toBe(null);
  const bin = join(mkdtempSync(join(TMP, "bin-")), "cloudflared");
  writeFileSync(
    bin,
    `#!/bin/sh
echo "INF Requesting new quick Tunnel on trycloudflare.com..." >&2
echo "INF +----------------------------------------------+" >&2
echo "INF |  https://some-words-here.trycloudflare.com    | args: $*" >&2
exec sleep 30
`,
  );
  chmodSync(bin, 0o755);
  const t = await tunnel(1234, { bin });
  expect(t.url).toBe("https://some-words-here.trycloudflare.com");
  t.stop();
  await expect(tunnel(1234, { bin: join(TMP, "no-such-cloudflared") })).rejects.toThrow(NO_CLOUDFLARED);

  // The dev server with it: callback and webhook URLs on the tunnel.
  const w = world();
  const d = await dev({ dir: project(), port: 0, env: w.env, watch: false, tunnel: { bin }, log: () => {} });
  running.push(d);
  expect(d.loaded()!.publicUrl).toBe("https://some-words-here.trycloudflare.com");
});

test("cli: help, flags, deploy slot", async () => {
  const out: string[] = [];
  const log = (s: string) => void out.push(s);
  expect(await main(["--help"], { log })).toBe(0);
  expect(out.at(-1)).toContain("connectd dev");
  expect(await main([], { log })).toBe(2);
  expect(await main(["dev", "--prot", "1"], { log })).toBe(2);
  expect(out.at(-1)).toStartWith("unknown flag --prot");
  expect(await main(["dev", "--port"], { log })).toBe(2);
  expect(await main(["dev", "--port", "x"], { log })).toBe(2);
  expect(await main(["deploy"], { log })).toBe(1);
  expect(await main(["dev", "--config", "nope.ts", "--port=0"], { log, dir: TMP })).toBe(1);
  expect(out.at(-1)).toContain("no nope.ts");
});

test("examples/basic loads", async () => {
  const dir = join(import.meta.dir, "..", "..", "..", "examples", "basic");
  const lines: string[] = [];
  const d = await dev({ dir, port: 0, env: { GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "y", DATABASE_URL: "postgres://app" }, watch: false, log: (l) => lines.push(l) });
  running.push(d);
  expect(d.loaded()!.project.definitions.map((x) => x.id)).toEqual(["github", "google", "notes", "slack"]);
  expect(d.loaded()!.unconfigured).toEqual(["google", "slack"]);
  // The providers read their own env names; the app's other vars aren't among them.
  expect(d.loaded()!.project.envNames).toEqual(["APP_ORIGIN", "EVENTS_URL", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"]);
  expect(lines.join("\n")).toContain("google (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET), slack (SLACK_CLIENT_ID, SLACK_CLIENT_SECRET)");
  expect(Object.keys(d.loaded()!.project.actions?.github ?? {})).toEqual(["profile"]);
});

test("swap: an instance moves to the new program only when idle, never two live handlers", async () => {
  const made: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const prog =
    (v: string): Program =>
    (_d, id) => {
      made.push(`${v}:${id}`);
      return { onCall: async (m) => (m === "slow" ? (await gate, v) : v), onTimer: async () => {} };
    };
  const hot = swappable();
  hot.swap(prog("v1"));
  const w = memory(hot.program);
  expect(await w.call("a", "fast", null)).toBe("v1");
  const slow = w.call("a", "slow", null);
  hot.swap(prog("v2"));
  // Busy: the new call joins the old handler; an idle instance moves at once.
  expect(await w.call("a", "fast", null)).toBe("v1");
  expect(await w.call("b", "fast", null)).toBe("v2");
  release();
  expect(await slow).toBe("v1");
  expect(await w.call("a", "fast", null)).toBe("v2");
  expect(made).toEqual(["v1:a", "v2:b", "v2:a"]);
});

test("state.json: owner-only, its writes don't trigger reloads, stop is idempotent", async () => {
  const w = world();
  const dir = project();
  const { d, oc, lines } = await start(dir, w.env, { watch: true });
  await oc.connection("keyed", "k1").connect({ key: "sekret" });
  const state = join(dir, ".connectd", "state.json");
  await until(() => existsSync(state));
  await Bun.sleep(700); // past another save tick and the watcher's debounce
  expect(statSync(state).mode & 0o777).toBe(0o600);
  expect(lines.some((l) => l.startsWith("reload"))).toBe(false);
  await Promise.all([d.stop(), d.stop()]);
  await d.stop();
});

test("env reads are by name: a config spreading env is refused; `connectd keys` prints fresh values", async () => {
  const { resolve } = await import("./project.ts");
  expect(() => resolve((env) => ({ ...env, definitions: [] }), { PATH: "/bin", CLOUDFLARE_API_TOKEN: "t" })).toThrow("spreading or listing env isn't supported");
  expect(resolve((env) => ({ definitions: [], ...(env.EVENTS_URL ? { events: { url: env.EVENTS_URL } } : {}) }), { EVENTS_URL: "https://a.test", PATH: "/bin" }).envNames).toEqual(["EVENTS_URL"]);
  const out: string[] = [];
  expect(await main(["keys"], { log: (l) => void out.push(l), dir: TMP })).toBe(0);
  const k = parseEnv(out.join("\n"));
  expect(k.CONNECTD_API_KEY).toMatch(/^oc_[A-Za-z0-9]{32}$/);
  expect(k.CONNECTD_EVENTS_SECRET).toStartWith("whsec_");
});

test("the dev server's node:http adapter: streamed bodies, each Set-Cookie, hop-by-hop headers dropped, HEAD", async () => {
  let seen: Headers | undefined;
  const s = await serve(0, async (req) => {
    seen = req.headers;
    if (new URL(req.url).pathname === "/broken") {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("part"));
          setTimeout(() => c.error(new Error("upstream went away")), 50);
        },
      });
      return new Response(body);
    }
    if (new URL(req.url).pathname === "/stream") {
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          await new Promise((r) => setTimeout(r, 100));
          c.enqueue(new TextEncoder().encode(`data: ${i}\n\n`));
          if (++i === 3) c.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    const h = new Headers({ "x-body": String((await req.arrayBuffer()).byteLength) });
    h.append("set-cookie", "a=1; Path=/");
    h.append("set-cookie", "b=2; Path=/");
    return new Response("ok", { headers: h });
  });
  try {
    // The first event arrives before the last is written.
    const res = await fetch(`http://localhost:${s.port}/stream`);
    const reader = res.body!.getReader();
    const t0 = performance.now();
    await reader.read();
    const first = performance.now() - t0;
    while (!(await reader.read()).done);
    expect(first).toBeLessThan(250);
    // A chunked upload: the handler sees the body, not the hop's transfer-encoding.
    const up = await fetch(`http://localhost:${s.port}/up`, { method: "POST", body: new Blob(["hello"]).stream(), duplex: "half" } as RequestInit);
    expect(up.headers.get("x-body")).toBe("5");
    expect(seen?.has("transfer-encoding")).toBe(false);
    expect(seen?.has("connection")).toBe(false);
    expect(up.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    // A body that fails partway ends the client's response with an error instead of leaving it hanging.
    const broken = await fetch(`http://localhost:${s.port}/broken`);
    expect(await Promise.race([broken.text().then(() => "ended", () => "failed"), new Promise((r) => setTimeout(() => r("hung"), 2000))])).toBe("failed");
    const head = await fetch(`http://localhost:${s.port}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
  } finally {
    await s.stop();
  }
});

test("watcher: build output, dependencies and hidden folders never reload; .env and sources do", () => {
  for (const p of [".next/server/app.js", "node_modules/x/i.js", ".connectd/state.json", ".git/index", "dist/a.js", "src/oc/x/.y.ts.swp", ".git", ".next", "next-env.d.ts", "tsconfig.tsbuildinfo"]) expect([p, ignored(p)]).toEqual([p, true]);
  for (const p of [".env", ".env.local", "oc.config.ts", "src/oc/github/connection.ts", "app/page.tsx"]) expect([p, ignored(p)]).toEqual([p, false]);
});
