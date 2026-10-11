import { decrypt, encrypt, type Keys } from "./crypto.ts";
import type { Driver, Json } from "./index.ts";

/** Kernel primitives for one connection instance, built on the driver. */

export type State = "pending" | "active" | "reauth_required" | "revoked";

export type Credential = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  /** The provider's full token response (keeps extras like Salesforce instance_url). */
  raw: Record<string, Json>;
};

export type Snapshot = { v: number; state: State; credential: Credential | null };

const LEGAL: Record<State, State[]> = {
  pending: ["pending", "active", "revoked"],
  active: ["active", "reauth_required", "revoked"],
  reauth_required: ["active", "revoked"],
  revoked: [],
};

export class IllegalTransition extends Error {}

export function connection(d: Driver, keys: Keys) {
  const inflight = new Map<string, Promise<unknown>>();

  return {
    /** Short-lived flow data (PKCE verifier, nonce, device code). Consumed at most once. */
    handshake: {
      open: (id: string, data: Json, ttlMs: number) => d.store.put(`hs:${id}`, data, { ttlMs }),
      take: (id: string) => d.store.take(`hs:${id}`),
    },

    async read(): Promise<Snapshot | null> {
      const r = await d.store.get("record");
      if (!r) return null;
      const { state, credential } = r.value as { state: State; credential: string | null };
      return { v: r.v, state, credential: credential ? JSON.parse(await decrypt(credential, keys)) : null };
    },

    /**
     * Move to `to` if the record is still at `prev` (null = no record yet).
     * Returns false if someone else wrote first; the caller re-reads and decides.
     */
    async write(prev: Snapshot | null, to: State, credential: Credential | null): Promise<boolean> {
      if (prev ? !LEGAL[prev.state].includes(to) : to !== "pending" && to !== "active")
        throw new IllegalTransition(`${prev?.state ?? "none"} -> ${to}`);
      const value = { state: to, credential: credential ? await encrypt(JSON.stringify(credential), keys) : null };
      // ponytail: no event emit yet; lifecycle events (#7) hook in here.
      return d.store.cas("record", prev?.v ?? null, value);
    },

    /** Concurrent callers with the same key share one run. In-memory is enough: one instance per key. */
    once<T>(key: string, fn: () => Promise<T>): Promise<T> {
      let p = inflight.get(key) as Promise<T> | undefined;
      if (!p) {
        p = fn().finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      return p;
    },
  };
}

/** Build a credential from a token response; keeps the old refresh token if the provider didn't rotate it. */
export function credentialFrom(tok: Record<string, Json>, now: number, prev?: Credential | null): Credential {
  const refresh = typeof tok.refresh_token === "string" ? tok.refresh_token : prev?.refreshToken;
  return {
    accessToken: tok.access_token as string,
    ...(refresh ? { refreshToken: refresh } : {}),
    ...(typeof tok.expires_in === "number" ? { expiresAt: now + tok.expires_in * 1000 } : {}),
    raw: tok,
  };
}
