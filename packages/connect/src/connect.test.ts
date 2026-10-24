import { expect, test } from "bun:test";
import { claims, connect, type Result, resume, session } from "./connect.ts";
import { APP, OC, setup } from "./fake.ts";

const W = (w: unknown) => w as Window;
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
/** Let `connect()` poll after a close: 1 s apart, 10 times. */
const drain = async (w: { advance(ms: number): void }) => {
  for (let i = 0; i < 12; i++) {
    await settle();
    w.advance(1000);
  }
};
const watch = (p: Promise<Result>) => {
  const s: { r?: Result } = {};
  p.then((r) => (s.r = r));
  return s;
};

test("popup: opens synchronously, fetches a ticket, navigates, confirms the completion", async () => {
  const t = await setup();
  const token = await t.token("example", "u1");
  const p = connect({ url: `${OC}/`, token, window: W(t.win) });
  // Before any await: the popup is open (the click's user activation is still there).
  expect(t.win.opened).toHaveLength(1);
  await settle();
  const nav = t.win.navigations[0]!;
  expect(nav.popup).toBe(t.win.opened[0]!);
  expect(nav.url).toStartWith(`${OC}/session/authorize?ticket=`);
  expect(nav.url).not.toContain(encodeURIComponent(token)); // the token stays out of URLs

  const { html } = await t.finish();
  expect(html).toContain('"status":"authorized"');
  expect(await p).toEqual({ status: "connected" });
  expect(await t.status("example", "u1")).toBe("active");
  expect(t.win.messages).toHaveLength(0); // listener removed
});

test("popup: a token function is awaited after the window opened; failures close the popup, in the opener", async () => {
  const t = await setup();
  let release!: (s: string) => void;
  const p = connect({ url: OC, token: () => new Promise((r) => (release = r)), window: W(t.win) });
  expect(t.win.opened).toHaveLength(1);
  expect(t.win.navigations).toHaveLength(0);
  release(await t.token("example", "u1"));
  await settle();
  expect(t.win.navigations).toHaveLength(1);
  await t.finish();
  expect(await p).toEqual({ status: "connected" });

  expect(await connect({ url: OC, token: () => Promise.reject(new Error("backend down")), window: W(t.win) })).toEqual({ status: "error", code: "error", message: "backend down" });
  expect(t.win.opened[1]!.closed).toBe(true);
  // A refused ticket (here an expired-looking forged token) is an error in the opener, not JSON in the popup.
  expect(await connect({ url: OC, token: "forged", window: W(t.win) })).toMatchObject({ status: "error", code: "unauthorized" });
  expect(t.win.opened[2]!.closed).toBe(true);
  expect(t.win.navigations).toHaveLength(1);
});

test("popup closed while the token was being fetched: not navigated (that would open a tab)", async () => {
  const t = await setup();
  let release!: (s: string) => void;
  const p = connect({ url: OC, token: () => new Promise((r) => (release = r)), window: W(t.win) });
  t.win.opened[0]!.close();
  release(await t.token("example", "u1"));
  expect(await p).toEqual({ status: "closed" });
  expect(t.win.navigations).toHaveLength(0);
});

test("popup: messages from another origin, window or attempt are ignored; provider errors come back", async () => {
  const t = await setup();
  const p = connect({ url: OC, token: await t.token("example", "u1"), window: W(t.win) });
  await settle();
  const popup = t.win.opened[0]!;
  const nonce = (t.requests.find((r) => r.path === "/session/authorize")!.body as { nonce: string }).nonce;
  expect(nonce).toMatch(/^[0-9a-f]{24}$/);
  const ok = { type: "connectd", nonce, status: "connected" };
  t.win.post(ok, "https://evil.test", popup);
  t.win.post(ok, OC, {});
  t.win.post({ ...ok, nonce: "other" }, OC, popup);
  t.win.post("connected", OC, popup);
  const s = watch(p);
  await settle();
  expect(s.r).toBeUndefined();

  await t.finish({ deny: "access_denied" });
  expect(await p).toMatchObject({ status: "error", code: "access_denied" });
  expect(await t.status("example", "u1")).toBe("pending");
});

test("popup closed by the user (a while after it left): one look at the state, then closed; and timeout", async () => {
  const t = await setup();
  const p = connect({ url: OC, token: await t.token("example", "u1"), window: W(t.win) });
  await settle();
  t.win.advance(6_000); // the user was at the provider for a while
  t.win.opened[0]!.close();
  t.win.advance(300); // seen closed once: a message may still be in flight
  t.win.advance(300);
  expect(await p).toEqual({ status: "closed" });
  expect(t.win.timers).toHaveLength(0);
  expect(t.win.channels.size).toBe(0);

  const q = connect({ url: OC, token: await t.token("example", "u1"), window: W(t.win), timeoutMs: 5_000 });
  await settle();
  t.win.advance(5_000);
  expect(await q).toMatchObject({ status: "error", code: "timeout" });
  expect(t.win.opened[1]!.closed).toBe(true);
});

/** Closed right after it left: what Chromium shows when a provider page with COOP cuts the opener. */
async function coop(t: Awaited<ReturnType<typeof setup>>, token: string) {
  const p = connect({ url: OC, token, window: W(t.win), timeoutMs: 600_000 });
  const s = watch(p);
  await settle();
  t.win.advance(600);
  t.win.opened[0]!.close();
  // A slow login: a minute at the provider, and connect() is still waiting.
  for (let i = 0; i < 30; i++) {
    t.win.advance(2_000);
    await settle();
  }
  expect(s.r).toBeUndefined();
  const { returnUrl } = await t.finish({ noOpener: true });
  expect(returnUrl).toMatch(/^https:\/\/app\.test\/back#connectd=authorized&definition=example&id=u1&completion=[\w.-]+&nonce=[0-9a-f]{24}$/);
  // The app's page, loaded in the popup (same origin as the opener).
  const inPopup = Object.assign(Object.create(t.win), { name: "", close: () => {} }); // COOP cleared window.name
  t.win.location.href = returnUrl!;
  return { p, s, inPopup };
}

test("COOP: a slow login after the popup read as closed; resume() in the popup tells the opener on a BroadcastChannel", async () => {
  const t = await setup();
  const token = await t.token("example", "u1", { returnUrl: `${APP}/back` });
  const { p, inPopup } = await coop(t, token);
  expect(await resume({ url: OC, token, window: W(inPopup) })).toEqual({ status: "connected" });
  await settle();
  expect(await p).toEqual({ status: "connected" });
  expect(t.win.channels.size).toBe(0);
});

test("COOP without BroadcastChannel: the opener still sees it through the state", async () => {
  const t = await setup();
  const token = await t.token("example", "u1", { returnUrl: `${APP}/back` });
  const { p, s, inPopup } = await coop(t, token);
  inPopup.BroadcastChannel = undefined;
  expect(await resume({ url: OC, token, window: W(inPopup) })).toEqual({ status: "connected" });
  await settle();
  expect(s.r).toBeUndefined();
  t.win.advance(2_000);
  await settle();
  expect(await p).toEqual({ status: "connected" });
});

test("COOP-looking close that never finishes: closed at the timeout, not before", async () => {
  const t = await setup();
  const p = connect({ url: OC, token: await t.token("example", "u1"), window: W(t.win), timeoutMs: 120_000 });
  const s = watch(p);
  await settle();
  t.win.opened[0]!.close();
  for (let i = 0; i < 50; i++) {
    t.win.advance(2_000);
    await settle();
  }
  expect(s.r).toBeUndefined();
  t.win.advance(20_000);
  await settle();
  expect(await p).toEqual({ status: "closed" });
});

test("popup blocked: falls back to a redirect when the session has a returnUrl, else says so", async () => {
  const t = await setup();
  t.win.blockPopups = true;
  const token = await t.token("example", "u1", { returnUrl: `${APP}/settings` });
  expect(await connect({ url: OC, token, window: W(t.win) })).toEqual({ status: "redirecting" });
  expect(t.win.navigations[0]!.popup).toBeUndefined();
  const { location } = await t.finish();
  expect(location).toStartWith(`${APP}/settings#connectd=authorized&definition=example&id=u1&completion=`);
  expect(await t.status("example", "u1")).toBe("pending");
  t.win.location.href = location!;
  expect(await resume({ url: OC, token, window: W(t.win) })).toEqual({ status: "connected" });
  expect(await t.status("example", "u1")).toBe("active");
  expect(t.win.closed).toBe(false); // not a popup: resume() leaves the page alone

  expect(await connect({ url: OC, token: await t.token("example", "u2"), window: W(t.win) })).toMatchObject({ status: "error", code: "popup_blocked" });
  expect(await connect({ url: OC, token, window: W(t.win), fallback: false })).toMatchObject({ status: "error", code: "popup_blocked" });
});

test("redirect mode: navigates this window; resume() takes the result from the fragment and removes it", async () => {
  const t = await setup();
  const token = await t.token("example", "u1", { returnUrl: `${APP}/back?tab=2` });
  expect(await connect({ url: OC, token, mode: "redirect", window: W(t.win) })).toEqual({ status: "redirecting" });
  expect(t.win.opened).toHaveLength(0);
  const { location } = await t.finish();
  t.win.location.href = `${location}&mine=1`; // the app's own fragment keys survive
  expect(await resume({ url: OC, token: async () => token, window: W(t.win) })).toEqual({ status: "connected" });
  expect(t.win.location.href).toBe(`${APP}/back?tab=2#mine=1`);
  // A reload: nothing on the URL any more, nothing happens.
  expect(await resume({ url: OC, token, window: W(t.win) })).toBeNull();

  await connect({ url: OC, token, mode: "redirect", window: W(t.win) });
  t.win.location.href = (await t.finish({ deny: "access_denied" })).location!;
  expect(await resume({ url: OC, token, window: W(t.win) })).toEqual({ status: "error", code: "access_denied", message: "" });
  expect(t.win.location.href).toBe(`${APP}/back?tab=2`);
});

test("two connect buttons on the return page: each resume() takes only its own connection's outcome", async () => {
  const t = await setup();
  const gh = await t.token("example", "u1", { returnUrl: `${APP}/back` });
  const other = await t.token("example", "u2", { returnUrl: `${APP}/back` });
  const keyed = await t.token("keyed", "u1", { returnUrl: `${APP}/back` });
  await connect({ url: OC, token: gh, mode: "redirect", window: W(t.win) });
  t.win.location.href = (await t.finish()).location!;
  const before = t.win.location.href;
  // Other mounts (another id, another definition) leave it alone: no bad_completion, nothing removed.
  expect(await resume({ url: OC, token: other, window: W(t.win) })).toBeNull();
  expect(await resume({ url: OC, token: keyed, window: W(t.win) })).toBeNull();
  expect(t.win.location.href).toBe(before);
  expect(await resume({ url: OC, token: gh, window: W(t.win) })).toEqual({ status: "connected" });
  expect(t.win.location.href).toBe(`${APP}/back`);
  expect(t.win.history.replaced).toHaveLength(1);
});

test("fields: an API key through the session, no window; errors are results", async () => {
  const t = await setup();
  const token = await t.token("keyed", "k1");
  expect(await session({ url: OC, token, window: W(t.win) })).toMatchObject({ flow: "form", fields: ["apiKey", "region"], state: null });
  expect(await connect({ url: OC, token, fields: { apiKey: "sk" }, window: W(t.win) })).toEqual({ status: "error", code: "bad_request", message: "missing region" });
  expect(await connect({ url: OC, token, fields: { apiKey: "sk", region: "eu" }, window: W(t.win) })).toEqual({ status: "connected" });
  expect(t.win.opened).toHaveLength(0);
  expect(await t.status("keyed", "k1")).toBe("active");
  expect(await connect({ url: OC, token: "forged", fields: { apiKey: "x" }, window: W(t.win) })).toMatchObject({ status: "error", code: "unauthorized" });
  expect(session({ url: OC, token: "forged", window: W(t.win) })).rejects.toMatchObject({ code: "unauthorized" });
});

test("claims: readable, null for garbage", async () => {
  const t = await setup();
  expect(claims(await t.token("example", "u1", { returnUrl: `${APP}/x` }))).toMatchObject({ def: "example", id: "u1", origin: APP, returnUrl: `${APP}/x` });
  expect(claims("garbage")).toBeNull();
});

test("COOP wait: a `connected` broadcast is checked against the state; a dead session token ends the wait", async () => {
  const t = await setup();
  const token = await t.token("example", "u1", { returnUrl: `${APP}/back`, ttlMs: 1_000 });
  const p = connect({ url: OC, token, window: W(t.win) });
  const s = watch(p);
  await settle();
  t.win.opened[0]!.close(); // reads as COOP: keeps waiting
  t.win.advance(600);
  await settle();
  // Another of the app's pages (or a script on the origin) says connected: the state says pending, so not believed.
  const nonce = (t.requests.find((r) => r.path === "/session/authorize")!.body as { nonce: string }).nonce;
  const bc = new t.win.BroadcastChannel(`connectd:${nonce}`);
  bc.postMessage({ type: "connectd", nonce, status: "connected" });
  await settle();
  expect(s.r).toBeUndefined();
  bc.close();
  // The session token expires: the next look gets session_expired, which no wait outlives.
  await Bun.sleep(1_100);
  t.win.advance(2_000);
  await settle();
  expect(await p).toEqual({ status: "closed" });
});

test("signal: aborting closes the popup and resolves aborted; an aborted signal never opens one", async () => {
  const t = await setup();
  const c = new AbortController();
  const p = connect({ url: OC, token: await t.token("example", "u1"), window: W(t.win), signal: c.signal });
  await settle();
  c.abort();
  expect(await p).toEqual({ status: "error", code: "aborted", message: "aborted" });
  expect(t.win.opened[0]!.closed).toBe(true);
  expect(t.win.timers).toHaveLength(0);
  expect(await connect({ url: OC, token: "x", window: W(t.win), signal: c.signal })).toMatchObject({ code: "aborted" });
  expect(t.win.opened).toHaveLength(1);
});
