// Kernel v2 on the Durable Object driver (#53): a program exercising each stored tool, driven by v2.test.ts.
import type { Handler, Json, Program } from "../src/driver.ts";
import { importHmacKey, importKeys } from "../src/primitives/secrets.ts";
import { kernel } from "../src/v2/kernel.ts";

/** Shared with v2.test.ts through globalThis (the worker and the tests run in one isolate). */
export const log = globalThis as { ocV2?: { down: boolean; delivered: string[]; tries: number[] } };
log.ocV2 ??= { down: false, delivered: [], tries: [] };
const s = () => log.ocV2!;

const raw = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));

/** Keys are imported on the first event (Workers can't do crypto at global scope), as the runtime host does. */
export const v2: Program = (d, instance) => {
  let ready: Promise<Handler> | undefined;
  async function init(): Promise<Handler> {
    const k = kernel(d, { instance, keys: await importKeys({ 1: raw(1) }, 1), stateKey: await importHmacKey(raw(9)) });
    const counter = k.cell<{ n: number }, string>("counter");
    const events = k.queue<string>("events", {
      deliver: async (m) => (s().down ? "HTTP 503" : (s().delivered.push(`${m.seq}:${m.msg}`), null)),
      retry: { baseMs: 1000, maxMs: 1000 },
    });
    const flaky = k.timer("flaky", {
      handle: async (_p, { attempt }) => {
        s().tries.push(attempt);
        throw new Error("down");
      },
      retry: { baseMs: 1000, maxMs: 1000, maxAttempts: 3 },
    });
    const login = k.ticket<{ verifier: string }>("login", { ttlMs: 60_000 });
    const own = k.limiter("proxy", { count: 10, periodMs: 1000 });
    const app = k.limiter.at("app:v2", "proxy", { count: 1, periodMs: 60_000 });
    return k.serve({
      inc: async () => (await counter.update((c, emit) => (emit(`n${(c?.n ?? 0) + 1}`), { n: (c?.n ?? 0) + 1 })))?.n ?? 0,
      relay: async () => (await events.relay(counter), null),
      push: async (a) => (await events.push(a as string[]), null),
      status: async () => (await events.status()) as unknown as Json,
      flaky: async () => (await flaky.set(d.now()), null),
      issue: async () => login.issue({ verifier: "v" }),
      redeem: async (t) => login.redeem(t as string),
      acquire: async () => (await k.acquire([own, app])) as unknown as Json,
    });
  }
  const h = () => (ready ??= init());
  return {
    onCall: async (m, a) => (await h()).onCall(m, a),
    onTimer: async (n, p) => (await h()).onTimer(n, p),
  };
};
