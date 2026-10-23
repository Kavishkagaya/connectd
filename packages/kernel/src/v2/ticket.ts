import type { Driver, Json } from "../driver.ts";
import { randomId, sign, verify } from "../primitives/secrets.ts";

export type Ticket<D extends Json> = {
  /** Keep `data` in this instance for `ttlMs`; returns a signed string naming the instance, the ticket and a random id. */
  issue(data: D): Promise<string>;
  /** The data, at most once. Null if forged, used, expired, or another instance's or ticket's. */
  redeem(t: string): Promise<D | null>;
};

/**
 * Which instance and ticket a signed ticket names, with no lookup (the Worker routes callbacks
 * with it). Null if forged or malformed. Signed, not encrypted: the instance name is readable.
 */
export async function routeTicket(t: string, stateKey: CryptoKey): Promise<{ instance: string; name: string; id: string } | null> {
  const p = await verify(t, stateKey);
  if (!p) return null;
  let v: unknown;
  try {
    v = JSON.parse(p);
  } catch {
    return null;
  }
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === "string")) return null;
  const [instance, name, id] = v as [string, string, string];
  return { instance, name, id };
}

/**
 * A signed, one-time, expiring pass (OAuth `state`, session tickets). Only a reference travels:
 * the data (a PKCE verifier) stays in the instance. `take` makes redemption single-use.
 */
export function ticket<D extends Json>(d: Driver, instance: string, name: string, key: (id: string) => string, stateKey: CryptoKey, ttlMs: number): Ticket<D> {
  return {
    async issue(data) {
      const id = randomId();
      await d.store.put(key(id), data, { ttlMs });
      return sign(JSON.stringify([instance, name, id]), stateKey);
    },
    async redeem(t) {
      const r = await routeTicket(t, stateKey);
      if (!r || r.instance !== instance || r.name !== name) return null;
      return (await d.store.take(key(r.id))) as D | null;
    },
  };
}
