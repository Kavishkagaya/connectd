import { applyD1Migrations, type D1Migration, listDurableObjectIds, reset, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Json } from "../src/platform.ts";
import { cloudflarePlatform } from "../src/drivers/do.ts";
import { parity, platformParity, type World } from "../src/drivers/parity.ts";
import { PROBE } from "./worker.ts";

const e = env as unknown as Record<string, unknown> & { PROBE: DurableObjectNamespace; DB: D1Database; MIGRATIONS: D1Migration[] };
const g = globalThis as { ocNow?: number };

beforeEach(() => applyD1Migrations(e.DB, e.MIGRATIONS));
afterEach(() => reset()); // wipe DO storage, D1 and instances between tests

// The probe's platform is built from the same env (PARITY_VALUE is a binding in vitest.config.ts).
const world = (): World => {
  const platform = cloudflarePlatform(e, PROBE);
  return {
    platform,
    call: (id: string, method: string, args: Json) => platform.atoms.call(id, method, args),
    async advance(ms: number) {
      g.ocNow! += ms;
      // reset() leaves earlier tests' ids listed with empty storage: a DO that was never created by
      // name here has no name stored and no timers, and refuses to start. Skip exactly those.
      for (const id of await listDurableObjectIds(e.PROBE))
        await runDurableObjectAlarm(e.PROBE.get(id)).catch((x: Error) => {
          if (!x.message.includes("must be created with idFromName")) throw x;
        });
    },
  };
};

parity("do", world, { test, expect });
platformParity("do", world, { test, expect });
