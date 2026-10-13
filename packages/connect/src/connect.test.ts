import { expect, test } from "bun:test";
import { claims, connect, readResult, session } from "./connect.ts";
import { APP, OC, setup } from "./fake.ts";

const W = (w: unknown) => w as Window;

test("popup: opens synchronously, submits the token by form, resolves with the opener message", async () => {
  const t = await setup();
  const token = await t.token("example", "u1");
  const p = connect({ url: `${OC}/`, token, window: W(t.win) });
  // Before any await: the popup is open (the click's user activation is still there).
  expect(t.win.opened).toHaveLength(1);
  await Promise.resolve();
  const f = t.win.submitted[0]!;
  expect(f).toMatchObject({ action: `${OC}/session/authorize`, method: "POST", target: t.win.opened[0]!.name, fields: { token, mode: "popup" } });
  expect(t.win.document.body.children).toHaveLength(0); // the form is gone again

  const { html } = await t.finish();
  expect(html).toContain("postMessage");
  expect(await p).toEqual({ status: "connected" });
  expect(await t.status("example", "u1")).toBe("active");
  expect(t.win.messages).toHaveLength(0); // listener removed
});

test("popup: a token function is awaited after the window opened; its failure closes the popup", async () => {
  const t = await setup();
  let release!: (s: string) => void;
  const p = connect({ url: OC, token: () => new Promise((r) => (release = r)), window: W(t.win) });
  expect(t.win.opened).toHaveLength(1);
  expect(t.win.submitted).toHaveLength(0);
  release(await t.token("example", "u1"));
  await new Promise((r) => setTimeout(r, 0));
  expect(t.win.submitted).toHaveLength(1);
  await t.finish();
  expect(await p).toEqual({ status: "connected" });

  const q = connect({ url: OC, token: () => Promise.reject(new Error("backend down")), window: W(t.win) });
  expect(await q).toEqual({ status: "error", code: "error", message: "backend down" });
  expect(t.win.opened[1]!.closed).toBe(true);
});

test("popup: messages from another origin, window or attempt are ignored; provider errors come back", async () => {
  const t = await setup();
  const p = connect({ url: OC, token: await t.token("example", "u1"), window: W(t.win) });
  await Promise.resolve();
  const popup = t.win.opened[0]!;
  const nonce = t.win.submitted[0]!.fields.nonce;
  const ok = { type: "openconnect", nonce, status: "connected" };
  t.win.post(ok, "https://evil.test", popup);
  t.win.post(ok, OC, {});
  t.win.post({ ...ok, nonce: "other" }, OC, popup);
  t.win.post("connected", OC, popup);
  let settled = false;
  p.then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 0));
  expect(settled).toBe(false);

  await t.finish({ deny: "access_denied" });
  expect(await p).toMatchObject({ status: "error", code: "access_denied" });
  expect(await t.status("example", "u1")).toBe("pending");
});

test("popup: closed before it reported, and timeout", async () => {
  const t = await setup();
  const p = connect({ url: OC, token: await t.token("example", "u1"), window: W(t.win) });
  await Promise.resolve();
  t.win.opened[0]!.close();
  t.win.advance(300); // seen closed once: a message may still be in flight
  t.win.advance(300);
  expect(await p).toEqual({ status: "closed" });
  expect(t.win.timers).toHaveLength(0);

  const q = connect({ url: OC, token: await t.token("example", "u1"), window: W(t.win), timeoutMs: 5_000 });
  await Promise.resolve();
  t.win.advance(5_000);
  expect(await q).toMatchObject({ status: "error", code: "timeout" });
  expect(t.win.opened[1]!.closed).toBe(true);
});

test("popup blocked: falls back to a redirect when the session has a returnUrl, else says so", async () => {
  const t = await setup();
  t.win.blockPopups = true;
  const token = await t.token("example", "u1", { returnUrl: `${APP}/settings` });
  expect(await connect({ url: OC, token, window: W(t.win) })).toEqual({ status: "redirecting" });
  expect(t.win.submitted[0]).toMatchObject({ target: "_self", fields: { mode: "redirect" } });
  const { location } = await t.finish();
  expect(location).toBe(`${APP}/settings?openconnect=connected`);
  expect(readResult(location!)).toEqual({ status: "connected" });

  expect(await connect({ url: OC, token: await t.token("example", "u2"), window: W(t.win) })).toMatchObject({ status: "error", code: "popup_blocked" });
  expect(await connect({ url: OC, token, window: W(t.win), fallback: false })).toMatchObject({ status: "error", code: "popup_blocked" });
});

test("redirect mode: navigates this window; the result is read back from the return URL", async () => {
  const t = await setup();
  const token = await t.token("example", "u1", { returnUrl: `${APP}/back` });
  expect(await connect({ url: OC, token, mode: "redirect", window: W(t.win) })).toEqual({ status: "redirecting" });
  expect(t.win.opened).toHaveLength(0);
  const { location } = await t.finish({ deny: "access_denied" });
  expect(readResult(location!)).toEqual({ status: "error", code: "access_denied", message: "" });
  expect(readResult(`${APP}/back`)).toBeNull();
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
