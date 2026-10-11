import { listDurableObjectIds, reset, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";
import type { Json } from "../src/index.ts";
import { parity } from "../src/parity.ts";

const ns = (env as unknown as { PROBE: DurableObjectNamespace }).PROBE;
const g = globalThis as { ocNow?: number };

afterEach(() => reset()); // wipe DO storage and instances between tests

parity(
  "do",
  () => ({
    call: (id: string, method: string, args: Json) =>
      (ns.get(ns.idFromName(id)) as unknown as { onCall(m: string, a: Json): Promise<Json> }).onCall(method, args),
    async advance(ms: number) {
      g.ocNow! += ms;
      for (const id of await listDurableObjectIds(ns)) await runDurableObjectAlarm(ns.get(id));
    },
  }),
  { test, expect },
);
