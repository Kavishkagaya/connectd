import { listDurableObjectIds, reset, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";
import type { Json } from "../src/driver.ts";
import { log } from "./v2.ts";

// Kernel v2's tools on real Durable Objects (SQLite storage, alarms) in workerd. The memory driver
// suites under src/v2 cover the details; this checks they hold on the production driver.

const ns = (env as unknown as { V2: DurableObjectNamespace }).V2;
const g = globalThis as { ocNow?: number };
const call = (id: string, method: string, args: Json = null) =>
  (ns.get(ns.idFromName(id)) as unknown as { onCall(m: string, a: Json): Promise<Json> }).onCall(method, args);
async function advance(ms: number) {
  g.ocNow! += ms;
  for (const id of await listDurableObjectIds(ns)) await runDurableObjectAlarm(ns.get(id));
}

afterEach(async () => {
  await reset();
  log.ocV2 = { down: false, delivered: [], tries: [] };
});

test("v2 on DO: parallel cell updates all land", async () => {
  await Promise.all(Array.from({ length: 10 }, () => call("a", "inc")));
  expect(await call("a", "inc")).toBe(11);
});

test("v2 on DO: relay + push deliver in order; a failure parks and retries", async () => {
  await call("a", "inc");
  await call("a", "relay");
  log.ocV2!.down = true;
  await call("a", "push", ["webhook"]);
  await advance(0);
  const s = (await call("a", "status")) as { pending: number; error: string };
  expect([s.pending, s.error]).toEqual([2, "HTTP 503"]);
  log.ocV2!.down = false;
  await advance(1000);
  expect(log.ocV2!.delivered).toEqual(["1:n1", "2:webhook"]);
});

test("v2 on DO: a throwing timer retries, then gives up", async () => {
  await call("a", "flaky");
  for (let i = 0; i < 5; i++) await advance(1000);
  expect(log.ocV2!.tries).toEqual([0, 1, 2]);
});

test("v2 on DO: a ticket redeems once, only where it was issued", async () => {
  const t = (await call("a", "issue")) as string;
  expect(await call("b", "redeem", t)).toBeNull();
  expect(await call("a", "redeem", t)).toEqual({ verifier: "v" });
  expect(await call("a", "redeem", t)).toBeNull();
});

test("v2 on DO: a limiter in another instance is shared, all or nothing", async () => {
  expect(await call("a", "acquire")).toEqual({ ok: true });
  expect(((await call("b", "acquire")) as { ok: boolean }).ok).toBe(false);
});
