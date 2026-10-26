import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hmacHex } from "@kavishkagaya/connectd-connections";
import { sourceHash } from "../build.ts";
import { js, version } from "./assets.ts";
import { API_KEY, CLIENT_SECRET, EVENTS_SECRET, OC, setup, T0, tickFailures } from "./fake.ts";
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
  for (const path of ["/dashboard/api/overview", "/dashboard/api/connections/keyed/k1", "/dashboard/api/failures"]) {
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
    version: "dev",
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
        subscribes: true,
        actions: [
          {
            id: "star",
            every: null,
            on: null,
            input: true,
            schema: { type: "object", properties: { repo: { type: "string", description: "owner/name" }, stars: { type: "number" } }, required: ["repo"] },
          },
          // No JSON Schema from its validator: the UI falls back to a JSON text box.
          { id: "echo", every: null, on: null, input: true, schema: null },
          { id: "tick", every: 600_000, on: null, input: false, schema: null },
        ],
      },
      { id: "example", flow: "redirect", fields: [], configured: true, missing: [], proxy: null, webhooks: null, subscribes: false, actions: [] },
      { id: "half", flow: "redirect", fields: [], configured: true, missing: ["clientId", "clientSecret"], proxy: null, webhooks: null, subscribes: false, actions: [] },
      { id: "absent", flow: "redirect", fields: [], configured: false, missing: [], proxy: null, webhooks: null, subscribes: false, actions: [] },
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
    webhooks: { ok: { supported: true, registers: false, url: `${OC}/webhooks/keyed/k1`, registration: null, pending: false, subscriptions: 0 } },
    actions: { ok: [{ id: "star", next: null }, { id: "echo", next: null }, { id: "tick", every: 600_000, next: T0 + 600_000 }] },
    subscriptions: { ok: [] },
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
  // A definition without actions or subscriptions doesn't ask for them.
  await t.api("/connections/example/e1/connect", null);
  expect((await t.api("/dashboard/api/connections/example/e1")).body).toMatchObject({ actions: null, subscriptions: null });

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

test("failures: failed scheduled runs across connections, newest first, from their kept events", async () => {
  const t = await setup();
  for (const id of ["k1", "k2"]) await t.api(`/connections/keyed/${id}/connect`, { apiKey: `sk_${id}` });
  // A webhook whose topic ends in .failed is not an action failure.
  const { url, secret } = (await t.api("/connections/keyed/k1/webhooks.endpoint", null)).body;
  const hook = JSON.stringify({ topic: "tick.failed" });
  expect((await t.fetch(url, { method: "POST", body: hook, headers: { "x-sig": await hmacHex(secret, hook) } })).status).toBe(200);
  tickFailures.left = 1;
  await t.w.advance(10 * 60_000); // one tick fails (k1 or k2, whichever ran first), the other succeeds
  await t.w.advance(1);
  const f = (await t.api("/dashboard/api/failures")).body;
  expect(f).toMatchObject({ scanned: 2, more: false });
  expect(f.failures).toEqual([{ def: "keyed", id: expect.any(String), action: "tick", trigger: "every", error: "provider down", attempt: 1, at: expect.any(Number) }]);
  expect((await t.api("/dashboard/api/failures?def=example")).body).toEqual({ failures: [], scanned: 0, more: false });
  expect((await t.api("/dashboard/api/failures?def=nope")).status).toBe(404);
  // Without an index there's nothing to scan.
  const bare = await setup({ extensions: [dashboard()] });
  expect((await bare.api("/dashboard/api/failures")).body.error.code).toBe("not_found");
});
