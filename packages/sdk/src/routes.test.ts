import { expect, test } from "bun:test";
import { connectd } from "./client.ts";
import { listen } from "./listen.ts";
import { SECRET, setup } from "./testing.ts";

const APP = "https://app.test";

/** The app on its route (`/api/connectd/*`): the signed-in user is the `x-user` header. */
async function wired() {
  const t = await setup();
  const got: string[] = [];
  const fetch = (input: string, init: RequestInit) => t.rt.fetch(new Request(input, init), t.w.platform);
  const app = connectd({
    url: "https://oc.test",
    apiKey: "secret",
    fetch,
    user: (req) => req.headers.get("x-user"),
    events: { secret: SECRET, now: t.w.now },
    listeners: {
      example: listen("example")
        .on("connection.active", (e) => void got.push(`${e.connection.definition} ${e.connection.id} ${e.data.to}`))
        .on("*", (e) => void got.push(`* ${e.type}`)),
      keyed: listen("keyed").on("connection.active", (e) => void got.push(`keyed ${e.connection.id}`)),
    },
  });
  // The runtime's events go to the app's route.
  t.receiver((req) => app.routes.POST(new Request(`${APP}/api/connectd/events`, req)));
  const get = (path: string, user?: string) => app.routes.GET(new Request(`${APP}/api/connectd${path}`, { headers: user ? { "x-user": user } : {} }));
  const confirm = (body: object, user = "u1", origin = APP) =>
    app.routes.POST(new Request(`${APP}/api/connectd/return`, { method: "POST", headers: { "x-user": user, origin, "content-type": "application/json" }, body: JSON.stringify(body) }));

  /** The browser from the app's connect link to the return page's URL (fragment included). */
  async function browse(path: string, user: string) {
    const start = await get(path, user);
    expect(start.status).toBe(303);
    const nav = await fetch(start.headers.get("location")!, { redirect: "manual" });
    expect(nav.status).toBe(303);
    const cookie = nav.headers.get("set-cookie")!.split(";")[0]!;
    const back = t.approve(nav.headers.get("location")!);
    const cb = await fetch(`https://oc.test/callback?code=${back.code}&state=${encodeURIComponent(back.state)}`, { headers: { cookie }, redirect: "manual" });
    expect(cb.status).toBe(303);
    const to = new URL(cb.headers.get("location")!);
    return { to, f: new URLSearchParams(to.hash.slice(1)) };
  }
  return { ...t, app, got, get, confirm, browse };
}

test("app route: connect the signed-in user, confirm on return, events to the folder's listeners", async () => {
  const t = await wired();
  const { to, f } = await t.browse("/connect/example?return=/settings", "u1");
  // Back on the app's return page, the outcome in the fragment (never sent to a server).
  expect(`${to.origin}${to.pathname}${to.search}`).toBe(`${APP}/api/connectd/return?return=%2Fsettings`);
  expect(Object.fromEntries(f)).toMatchObject({ connectd: "authorized", definition: "example", id: "u1" });
  const page = await t.get(`/return${to.search}`);
  expect(page.headers.get("content-security-policy")).toContain("script-src 'nonce-");
  expect(await page.text()).toContain('new URL("/settings", location.origin)');

  // The page confirms; only the signed-in user's own connection, only from the app's own page.
  const body = { definition: "example", id: "u1", completion: f.get("completion") };
  expect((await t.confirm(body, "u2")).status).toBe(403);
  expect((await t.confirm(body, "u1", "https://evil.test")).status).toBe(403);
  const ok = await t.confirm(body);
  expect(await ok.json()).toEqual({ connected: true });
  expect((await t.oc.connection("example", "u1").status()).state).toBe("active");
  // Single use.
  expect((await t.confirm(body)).status).toBe(400);

  await t.w.advance(0);
  // The keyed listener never sees example's events.
  expect(t.got).toEqual(["* connection.pending", "example u1 active", "* connection.active"]);
});

test("app route: accounts, return paths, who may connect", async () => {
  const t = await wired();
  expect((await t.get("/connect/example")).status).toBe(401);
  expect((await t.get("/connect/example?account=a.b", "u1")).status).toBe(400);
  expect((await t.get("/connect/nope", "u1")).status).toBe(404);
  expect((await t.get("/elsewhere", "u1")).status).toBe(404);
  // Another account of the same user: its own connection id.
  const { f } = await t.browse("/connect/example?account=work&return=//evil.test", "u1");
  expect(f.get("id")).toBe("u1:work");
  expect(await (await t.confirm({ definition: "example", id: "u1:work", completion: f.get("completion") })).json()).toEqual({ connected: true });
  // A return path off this origin becomes "/".
  expect(await (await t.get("/return?return=//evil.test")).text()).toContain('new URL("/", location.origin)');
  // An API-key definition: the runtime's hosted page asks for the key, then the return page confirms it for the signed-in user.
  const keyed = await t.get("/connect/keyed?return=/settings", "u1");
  expect(keyed.status).toBe(303);
  const link = new URL(keyed.headers.get("location")!);
  expect(`${link.origin}${link.pathname}`).toBe("https://oc.test/connect");
  const token = new URLSearchParams(link.hash.slice(1)).get("token")!;
  const page = (path: string, body?: object) =>
    t.rt.fetch(
      new Request(`https://oc.test/session${path}`, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${token}`, "sec-fetch-site": "same-origin", ...(body ? { origin: "https://oc.test" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      t.w.platform,
    );
  expect(await (await page("")).json()).toMatchObject({ definition: "keyed", id: "u1", flow: "form", confirm: true, next: `${APP}/api/connectd/return?return=%2Fsettings` });
  const { completion } = (await (await page("/connect", { fields: { key: "sk" } })).json()) as { completion: string };
  // Forwarded to someone else: their confirm is refused, and nothing was connected.
  expect((await t.confirm({ definition: "keyed", id: "u1", completion }, "u2")).status).toBe(403);
  expect(await (await t.confirm({ definition: "keyed", id: "u1", completion })).json()).toEqual({ connected: true });
  await t.w.advance(0);
  expect(t.got).toContain("keyed u1");
});

test("connectd(): env defaults, listeners checked against their ids", () => {
  expect(() => connectd({ listeners: { github: listen("example") } })).toThrow('its events.ts must export default listen("github")');
  const before = process.env.CONNECTD_URL;
  delete process.env.CONNECTD_URL;
  // Read on first use, not on import: building the app without the env works.
  const oc = connectd();
  expect(() => oc.connection("example", "u1").status()).toThrow("CONNECTD_URL is not set");
  if (before !== undefined) process.env.CONNECTD_URL = before;
});

test("app route, refused: return paths off the origin (tabs and newlines too), cross-site starts, odd paths, no Origin, bad signatures", async () => {
  const t = await wired();
  for (const r of ["/%09/evil.test", "/%0A/evil.test", "/%0D/evil.test", "//evil.test", "/\\evil.test", "https://evil.test/x"])
    expect(await (await t.get(`/return?return=${r}`)).text()).toContain('new URL("/", location.origin)');
  expect(await (await t.get("/return?return=/settings%3Ftab%3D1")).text()).toContain('new URL("/settings?tab=1", location.origin)');
  // A link from another site can't start a connect for the signed-in user.
  const cross = await t.app.routes.GET(new Request(`${APP}/api/connectd/connect/example`, { headers: { "x-user": "u1", "sec-fetch-site": "cross-site" } }));
  expect(cross.status).toBe(403);
  // connect/:def first: a definition named `return` is a connect (here unknown), not the page.
  expect((await t.get("/connect/return", "u1")).status).toBe(404);
  expect((await t.get("/connect/%E0", "u1")).status).toBe(400);
  const noOrigin = await t.app.routes.POST(new Request(`${APP}/api/connectd/return`, { method: "POST", headers: { "x-user": "u1" }, body: "{}" }));
  expect(noOrigin.status).toBe(403);
  expect((await t.app.routes.POST(new Request(`${APP}/api/connectd/events`, { method: "POST", body: "{}" }))).status).toBe(401);
});

test("app route: user ids are strings without ':' (numbers are fine)", async () => {
  const t = await setup();
  const fetch = (input: string, init: RequestInit) => t.rt.fetch(new Request(input, init), t.w.platform);
  const colon = connectd({ url: "https://oc.test", apiKey: "secret", fetch, user: () => "org:1" });
  await expect(colon.routes.GET(new Request(`${APP}/api/connectd/connect/example`))).rejects.toThrow("user ids can't contain");
  const numeric = connectd({ url: "https://oc.test", apiKey: "secret", fetch, user: () => 42 });
  const r = await numeric.routes.GET(new Request(`${APP}/api/connectd/connect/example`));
  expect(r.status).toBe(303);
  void (() => {
    // @ts-expect-error a typo'd type, refused without a registry too
    listen("example").on("connection.actve", () => {});
  });
});
