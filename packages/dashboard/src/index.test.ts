import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hmacHex } from "@openconnect/connections";
import { sourceHash } from "../build.ts";
import { js, version } from "./assets.ts";
import { API_KEY, CLIENT_SECRET, EVENTS_SECRET, OC, setup } from "./fake.ts";
import { CSP, dashboard } from "./index.ts";

test("assets.ts is built from the current sources (run `bun run build` in packages/dashboard)", () => {
  expect(version).toBe(sourceHash());
  // Type imports only: no runtime code is bundled into the browser.
  expect(js.length).toBeLessThan(40_000);
  expect(js).not.toContain("conn:");
});

test("the UI never parses API data as markup", () => {
  const src = readFileSync(`${import.meta.dir}/app.ts`, "utf8");
  expect(src.match(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/g)).toBeNull();
});

test("the page is public, with a strict CSP; its script and style are versioned", async () => {
  const t = await setup();
  for (const path of ["/dashboard", "/dashboard/"]) {
    const res = await t.fetch(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    // No inline script or style for the CSP to allow: only same-origin files.
    expect(html.match(/<script[^>]*>/g)).toEqual([`<script type="module" src="/dashboard/app.js?v=${version}">`]);
    expect(html).toContain(`href="/dashboard/app.css?v=${version}"`);
    expect(html).not.toContain(API_KEY);
  }
  const versioned = await t.fetch(`/dashboard/app.js?v=${version}`);
  expect(versioned.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(versioned.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(await versioned.text()).toBe(js);
  expect((await t.fetch("/dashboard/app.js?v=old")).headers.get("cache-control")).toBe("no-cache");
  expect((await t.fetch("/dashboard/app.css")).headers.get("content-type")).toBe("text/css; charset=utf-8");
  expect(await (await t.fetch("/dashboard", { method: "HEAD" })).text()).toBe("");
  expect((await t.fetch("/dashboard", { method: "POST" })).status).toBe(405);
  expect((await t.fetch("/dashboard/nope")).status).toBe(404);
  expect((await t.fetch("/dashboard/app.js/x")).status).toBe(404);
});

test("the API needs the API key", async () => {
  const t = await setup();
  for (const path of ["/dashboard/api/overview", "/dashboard/api/connections/keyed/k1"]) {
    expect((await t.fetch(path)).status).toBe(401);
    expect((await t.fetch(path, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await t.fetch(path, { headers: { cookie: `key=${API_KEY}` } })).status).toBe(401);
  }
  expect((await t.api("/dashboard/api/overview", {})).status).toBe(405);
  expect((await t.api("/dashboard/api/nope")).status).toBe(404);
  expect((await t.api("/dashboard/api/connections/keyed")).status).toBe(404);
  expect((await t.api("/dashboard/api/connections/nope/k1")).body.error.code).toBe("not_found");
});

test("overview: definitions with their config state and the URLs to register, no secret anywhere", async () => {
  const t = await setup();
  const { status, body } = await t.api("/dashboard/api/overview");
  expect(status).toBe(200);
  expect(body).toEqual({
    callbackUrl: `${OC}/callback`,
    index: true,
    events: { url: "https://app.test/events?…" },
    sessions: { origins: ["https://app.test"] },
    webhooks: { url: `${OC}/webhooks` },
    definitions: [
      {
        id: "keyed",
        flow: "form",
        fields: ["apiKey"],
        configured: true,
        missing: [],
        proxy: "https://api.keyed.test",
        webhooks: { app: `${OC}/webhooks/keyed`, connection: `${OC}/webhooks/keyed/:id`, registers: false },
      },
      { id: "example", flow: "redirect", fields: [], configured: true, missing: [], proxy: null, webhooks: null },
      { id: "half", flow: "redirect", fields: [], configured: true, missing: ["clientId", "clientSecret"], proxy: null, webhooks: null },
      { id: "absent", flow: "redirect", fields: [], configured: false, missing: [], proxy: null, webhooks: null },
    ],
  });
  const text = JSON.stringify(body);
  for (const s of [CLIENT_SECRET, "cid", EVENTS_SECRET, API_KEY, "in-the-url"]) expect(text).not.toContain(s);
});

test("one connection: status, external ids, the events outbox and webhooks, never the credential", async () => {
  const t = await setup();
  t.failEvents(500);
  expect((await t.api("/connections/keyed/k1/connect", { apiKey: "sk_live_1" })).status).toBe(200);
  const { url, secret } = (await t.api("/connections/keyed/k1/webhooks.endpoint", null)).body;
  const body = JSON.stringify({ n: 1 });
  expect((await t.fetch(url, { method: "POST", body, headers: { "x-sig": await hmacHex(secret, body) } })).status).toBe(200);
  await t.w.advance(0); // the first attempt fails

  const d = (await t.api("/dashboard/api/connections/keyed/k1")).body;
  expect(d).toMatchObject({
    definition: "keyed",
    id: "k1",
    status: { ok: { state: "active", metadata: { account: "sk_live_1" } } },
    external: { account: "sk_live_1" },
    events: { ok: { enabled: true, pending: 2, attempt: 1, error: "HTTP 500", recent: [] } },
    webhooks: { ok: { supported: true, registers: false, url: `${OC}/webhooks/keyed/k1`, registration: null, pending: false, subscriptions: null } },
  });
  expect(d.events.ok.queued.map((e: { type: string }) => e.type)).toEqual(["connection.active", "webhook.push"]);
  expect(JSON.stringify(d)).not.toContain(secret);

  // The actions it uses are the runtime's own routes.
  t.failEvents(200);
  await t.api("/connections/keyed/k1/events.flush", null);
  await t.w.advance(0);
  expect(t.delivered.length).toBe(2);
  expect((await t.api("/connections/keyed/k1/events.redeliver", { slot: 1 })).body).toEqual({ slot: 3 });
  await t.w.advance(0);
  expect(t.delivered[2]).toBe(t.delivered[0]!);

  // No connection yet: not_found, and nothing is created by looking.
  const none = (await t.api("/dashboard/api/connections/keyed/nobody")).body;
  expect(none).toMatchObject({ status: { error: { code: "not_found" } }, external: null, events: { ok: { pending: 0 } } });
  expect((await t.api("/connections?def=keyed")).body.connections.map((r: { id: string }) => r.id)).toEqual(["k1"]);
  expect(t.w.dump()["conn:keyed:nobody"]?.store ?? {}).toEqual({});
});

test("without the events and webhooks extensions, their parts say so; the rest still works", async () => {
  const t = await setup({ extensions: [dashboard()] });
  await t.api("/connections/keyed/k1/connect", { apiKey: "sk" });
  const d = (await t.api("/dashboard/api/connections/keyed/k1")).body;
  expect(d.status.ok.state).toBe("active");
  expect(d.events.error.code).toBe("bad_request");
  expect(d.webhooks.error.code).toBe("bad_request");
  expect((await t.api("/dashboard/api/overview")).body.index).toBe(false);
});
