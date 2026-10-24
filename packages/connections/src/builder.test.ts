import { expect, test } from "bun:test";
import { type Connection, connection, definitionOf } from "./builder.ts";
import type { Flows } from "./flows.ts";
import { defineConnection } from "./define.ts";
import type { OAuth2 } from "./lifecycle.ts";
import { OAuthError } from "./oauth.ts";
import { fakeOAuth, harness } from "./testing.ts";

const H = 3_600_000;
const TOKEN = "https://example.test/token";
type Config = { clientId: string; clientSecret: string; scopes?: string[]; tenant: string };

const provider = () =>
  fakeOAuth({
    tokenUrl: TOKEN,
    clientSecret: "cs",
    // The token comes back nested, like Slack's user tokens.
    issue: (n) => ({ nested: { access_token: `a${n}` }, refresh_token: `r${n}`, expires_in: 3600 }),
    error: (code) => ({ status: 400, body: { error: code === "invalid_grant" ? "token_dead" : "bad_code" } }),
    route: (url, req) =>
      url === "https://api.example.test/v1/me"
        ? Response.json({ id: "u1", auth: req.headers.get("authorization"), agent: req.headers.get("user-agent") })
        : new Response(null),
  });

const unnest = (t: Record<string, unknown>) => ({ ...t, access_token: (t.nested as { access_token: string }).access_token });

/** A shared base: each connection below adds to it without changing it. */
const base = (f: Flows<Config>) =>
  f
    .oauth2({ authorizeUrl: "https://example.test/authorize", tokenUrl: TOKEN, revokeUrl: "https://example.test/revoke" })
    .params((c) => ({ tenant: c.tenant }))
    .deadRefreshToken("token_dead")
    .callback(async (_ctx, params, next) => unnest(await next(params)))
    .refresh(async (_ctx, cred, next) => unnest(await next(cred)));

const example = connection("example")
  .config<Config>()
  .auth((f) => base(f).scopes("read"))
  .api({ baseUrl: "https://api.example.test/v1/", headers: { "user-agent": "openconnect" } })
  .limit({ connection: { count: 10, periodMs: 1000 } })
  .identity(async ({ api }) => api.get<{ id: string; auth: string; agent: string }>("/me"))
  .external((me) => ({ id: me.id }));

const config: Config = { clientId: "cid", clientSecret: "cs", tenant: "t1" };

test("builder: oauth2 overrides call the standard step through next; api backs identity; dead refresh token", async () => {
  const p = provider();
  const { w, get, callback } = await harness(example, config, p.fetch);
  const c = await get("conn:a");

  const url = new URL((await c.connect())!);
  expect(url.searchParams.get("scope")).toBe("read");
  expect(url.searchParams.get("tenant")).toBe("t1");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");

  await callback(p.approve(url.toString()));
  // identity's api: the base URL joined, the bearer token on, the default header added.
  expect(await c.metadata()).toEqual({ id: "u1", auth: "Bearer a1", agent: "openconnect" });
  expect(((await c.token()) as OAuth2).accessToken).toBe("a1");

  await w.advance(H);
  expect(((await c.token()) as OAuth2).accessToken).toBe("a2");

  p.s.live.clear();
  await expect(c.conn.refresh()).rejects.toMatchObject({ state: "reauth_required", reason: "invalid_grant" });

  const d = definitionOf(example);
  expect(d.id).toBe("example");
  expect(d.rate?.connection).toEqual({ count: 10, periodMs: 1000 });
  expect(d.external?.({ id: "u1", auth: "", agent: "" })).toEqual({ id: "u1" });
});

test("builder: immutable, so a shared base isn't changed by what's added to it", async () => {
  const p = provider();
  const read = connection("read").config<Config>().auth((f) => base(f).scopes("read"));
  const write = connection("write").config<Config>().auth((f) => base(f).scopes("write", "admin"));
  const plain = connection("plain").config<Config>().auth(base);
  const scope = async (x: Connection<string, Config, null>) => new URL((await (await (await harness(x, config, p.fetch)).get("conn:a")).connect())!).searchParams.get("scope");
  expect(await scope(read)).toBe("read");
  expect(await scope(write)).toBe("write admin");
  expect(await scope(plain)).toBeNull();

  const a = connection("x").config<Config>().auth(base);
  const b = a.api({ baseUrl: "https://a.test" });
  expect(definitionOf(a).proxy).toBeUndefined();
  expect(definitionOf(b).proxy?.baseUrl).toBe("https://a.test");
});

test("builder: an override that doesn't call next replaces the step; later overrides wrap earlier ones", async () => {
  const calls: string[] = [];
  const p = provider();
  const conn = connection("r")
    .config<Config>()
    .auth((f) =>
      base(f)
        .revoke(async (_ctx, cred, next) => {
          calls.push("inner");
          await next(cred);
        })
        .revoke(async (_ctx, cred, next) => {
          calls.push("outer");
          if (cred.kind === "oauth2" && cred.accessToken === "skip") return;
          await next(cred);
        }),
    );
  const { get, callback } = await harness(conn, config, p.fetch);
  const c = await get("conn:a");
  await callback(p.approve((await c.connect())!));
  await c.revoke();
  expect(calls).toEqual(["outer", "inner"]);
  // The innermost next is the standard RFC 7009 revoke.
  expect(p.s.requests.some((r) => r.url === "https://example.test/revoke")).toBe(true);

  // A callback override that throws stops the connect (nothing activated).
  const failing = connection("f")
    .config<Config>()
    .auth((f) =>
      base(f).callback(async () => {
        throw new OAuthError("nope", 400, null);
      }),
    );
  const h = await harness(failing, config, p.fetch);
  const fc = await h.get("conn:b");
  await expect(h.callback(p.approve((await fc.connect())!))).rejects.toThrow("nope");
  expect((await fc.conn.read())?.state).toBe("pending");
});

test("builder: apiKey with the key in a header; definitionOf passes a plain definition through", async () => {
  const notes = connection("notes")
    .config()
    .auth((f) => f.apiKey("key"))
    .api({ baseUrl: "https://notes.test/api", key: { header: "x-api-key" } })
    .identity(async ({ api }) => {
      const res = await api.fetch("whoami");
      if (!res.ok) throw new Error("bad key");
      return { key: res.headers.get("x-seen") };
    });
  const fetch = (async (url: string, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("x-api-key");
    return url === "https://notes.test/api/whoami" && key === "k1" ? new Response(null, { headers: { "x-seen": key } }) : new Response(null, { status: 401 });
  }) as typeof globalThis.fetch;
  const { get } = await harness(notes, null, fetch);
  const c = await get("conn:n");
  expect(definitionOf(notes).auth.fields).toEqual(["key"]);
  await expect(c.connect({ key: "wrong" })).rejects.toThrow("bad key");
  expect(await c.connect({ key: "k1" })).toBeNull();
  expect(await c.metadata()).toEqual({ key: "k1" });

  // Default headers plus a non-default key: both on the proxy's inject, request headers win.
  const both = connection("both")
    .config()
    .auth((f) => f.apiKey("key"))
    .api({ baseUrl: "https://b.test", headers: { "x-client": "oc", accept: "application/json" }, key: { query: "api_key" } })
    .limit({ app: { count: 1, periodMs: 1 } })
    .observe(() => ({ remaining: 0 }));
  const d = definitionOf(both);
  const u = new URL("https://b.test/x");
  const h = new Headers({ accept: "text/plain" });
  (d.proxy?.inject as (url: URL, h: Headers, c: unknown) => void)(u, h, { kind: "static", fields: { key: "k9" } });
  expect(u.searchParams.get("api_key")).toBe("k9");
  expect(h.get("x-client")).toBe("oc");
  expect(h.get("accept")).toBe("text/plain");
  expect(d.rate?.app).toEqual({ count: 1, periodMs: 1 });
  expect(d.rate?.observe?.(new Response(), 0)).toEqual({ remaining: 0 });

  const plain = defineConnection({ id: "plain", auth: { start: async () => ({ credential: { kind: "static", fields: {} } }) } });
  expect(definitionOf(plain)).toBe(plain);
});

test("builder: the types allow only the core's order", () => {
  const authed = connection("t").config<Config>().auth(base);
  // @ts-expect-error external needs identity first
  authed.external?.(() => ({}));
  const identified = authed.identity(async () => ({ id: "x" }));
  // @ts-expect-error api comes before identity
  identified.api?.({ baseUrl: "https://x.test" });
  // @ts-expect-error limit only after api
  authed.limit?.({});
  // @ts-expect-error external sees identity's type
  identified.external((m) => ({ id: m.nope }));
  // @ts-expect-error oauth2 needs a client id in the config
  connection("k").config<{ token: string }>().auth((f) => f.oauth2({ authorizeUrl: "", tokenUrl: "" }));
  // @ts-expect-error identity without .api() has no api
  authed.identity(async ({ api }) => api);
  const id: "t" = authed.id;
  expect(id).toBe("t");
});
