import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ConnectionEvent, openconnect } from "@openconnect/sdk";
import { main } from "./cli.ts";
import { type Dev, dev, swappable } from "./dev.ts";
import type { Program } from "@openconnect/kernel";
import { memory } from "@openconnect/kernel/memory";
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
import { apiKey, defineConnection, oauth2 } from "@openconnect/connections";
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
  for (const [f, s] of Object.entries({ "openconnect.config.ts": CONFIG, "label.ts": `export const label = "v1";\n`, ".dev.vars": "CLIENT_ID=cid\n", ...files }))
    writeFileSync(join(dir, f), s);
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
  return { d, lines, oc: openconnect({ url: d.url, apiKey: d.apiKey }) };
}

/** connect, the user approving at the provider, and the provider redirecting back to /callback. */
async function authorize(d: Dev, oc: ReturnType<typeof openconnect>, id: string) {
  const { url } = await oc.connection("example", id).connect();
  const state = new URL(url as string).searchParams.get("state") as string;
  const res = await fetch(`${d.url}/callback?code=c1&state=${encodeURIComponent(state)}`);
  expect(res.status).toBe(200);
}

test("keys: generated once into .openconnect/dev.vars, gitignored, kept across runs", async () => {
  const w = world();
  const dir = project();
  const a = await start(dir, w.env);
  expect(a.d.created).toBe(true);
  expect(a.d.apiKey).toMatch(/^oc_[A-Za-z0-9]{32}$/);
  expect(a.lines.join("\n")).toContain(a.d.apiKey);
  const vars = parseEnv(readFileSync(join(dir, ".openconnect", "dev.vars"), "utf8"));
  expect(Object.keys(vars).sort()).toEqual(
    ["OPENCONNECT_API_KEY", "OPENCONNECT_EVENTS_SECRET", "OPENCONNECT_KEY_V1", "OPENCONNECT_SESSIONS_KEY", "OPENCONNECT_STATE_KEY", "OPENCONNECT_WEBHOOKS_KEY"].sort(),
  );
  expect(vars.OPENCONNECT_EVENTS_SECRET).toStartWith("whsec_");
  expect(readFileSync(join(dir, ".openconnect", ".gitignore"), "utf8")).toBe("*\n");
  await a.d.stop();
  const b = await start(dir, w.env);
  expect(b.d.created).toBe(false);
  expect(b.d.apiKey).toBe(a.d.apiKey);
  // The project's own env wins over generated keys.
  writeFileSync(join(dir, ".dev.vars"), "CLIENT_ID=cid\nOPENCONNECT_API_KEY=mine\n");
  await b.d.stop();
  expect((await start(dir, w.env)).d.apiKey).toBe("mine");
});

test("config: function of the env (.dev.vars < process env), banner, unconfigured definitions", async () => {
  const w = world();
  const dir = project({ ".dev.vars": "" });
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
  const oc = openconnect({ url: d.url, apiKey: d.apiKey });
  await expect(oc.connection("example", "u1").connect()).rejects.toMatchObject({ code: "not_configured" });
  await d.stop();
  const again = await start(dir, { ...w.env, CLIENT_ID: "cid", OPENCONNECT_PUBLIC_URL: "https://dev.example.com/" });
  expect(again.d.loaded()!.unconfigured).toEqual([]);
  expect(again.d.loaded()!.publicUrl).toBe("https://dev.example.com");
  const { url } = await again.oc.connection("example", "u1").connect();
  expect(new URL(url!).searchParams.get("redirect_uri")).toBe("https://dev.example.com/callback");
});

test("config errors: no config file, duplicate ids, a broken config serves 503 until fixed", async () => {
  const w = world();
  await expect(dev({ dir: mkdtempSync(join(TMP, "e-")), port: 0, watch: false, log: () => {} })).rejects.toThrow(/no openconnect.config.ts/);
  const dir = project({ "openconnect.config.ts": `import { apiKey, defineConnection } from "@openconnect/connections";
const k = defineConnection({ id: "k", auth: apiKey(["key"]) });
export default { definitions: [k, k] };` });
  const { d, lines } = await start(dir, w.env);
  expect(lines.join("\n")).toContain("two definitions with id k");
  expect((await fetch(`${d.url}/connections/k/a`)).status).toBe(503);
  writeFileSync(join(dir, "openconnect.config.ts"), CONFIG);
  expect(await d.reload()).toBe(true);
  expect((await fetch(`${d.url}/connections/keyed/a`, { headers: { authorization: `Bearer ${d.apiKey}` } })).status).toBe(404);
});

test("dev server through the SDK: oauth2 and API-key connect, list, proxy, signed events", async () => {
  const w = world();
  const dir = project();
  const { d, oc } = await start(dir, w.env);
  const secret = parseEnv(readFileSync(join(dir, ".openconnect", "dev.vars"), "utf8")).OPENCONNECT_EVENTS_SECRET!;
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
  expect(existsSync(join(dir, ".openconnect", "state.json"))).toBe(true);

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
  expect(out.at(-1)).toContain("openconnect dev");
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
  const d = await dev({ dir, port: 0, env: { GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "y" }, watch: false, log: () => {} });
  running.push(d);
  expect(d.loaded()!.project.definitions.map((x) => x.id)).toEqual(["github", "slack", "google", "notes"]);
  expect(d.loaded()!.unconfigured).toEqual(["slack", "google"]);
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
  const state = join(dir, ".openconnect", "state.json");
  await until(() => existsSync(state));
  await Bun.sleep(700); // past another save tick and the watcher's debounce
  expect(statSync(state).mode & 0o777).toBe(0o600);
  expect(lines.some((l) => l.startsWith("reload"))).toBe(false);
  await Promise.all([d.stop(), d.stop()]);
  await d.stop();
});
