import { base64url, importHmacKey, importKeys, type Json, kernel, routeTicket } from "@openconnect/kernel";
import { memory } from "@openconnect/kernel/memory";
import { type Connection, definitionOf } from "./builder.ts";
import { bind, type Definition } from "./define.ts";

/** Test helpers for definitions: run one on the memory driver against a fake provider. Not for production. */

const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));

/** One definition on the in-memory driver, with the public /callback route. */
export async function harness<C, M extends Json>(d: Definition<C, M> | Connection<string, C, M>, config: C, fetch: typeof globalThis.fetch) {
  const def = definitionOf(d);
  const opts = { config, fetch, redirectUri: "https://oc.test/callback" };
  const keys = { keys: await importKeys({ 1: key(1) }, 1), stateKey: await importHmacKey(key(9)) };
  const bound = new Map<string, ReturnType<typeof bind<C, M>>>();
  const w = memory((d, id) => {
    const k = kernel(d, { instance: id, ...keys });
    bound.set(id, bind(def, k, opts));
    return k.serve({ init: async () => null });
  });
  const get = async (id: string) => {
    await w.call(id, "init", null);
    return bound.get(id)!;
  };
  /** Route by signed state, no lookup. */
  const callback = async (q: Record<string, string>) => {
    const r = await routeTicket(q.state ?? "", keys.stateKey);
    if (!r) throw new Error("bad state");
    return (await get(r.instance)).callback(q);
  };
  return { w, get, callback, keys };
}

export type FakeOAuth = {
  tokenUrl: string;
  /** Body for a successful grant; `n` counts issued tokens from 1. A refresh token must be `r${n}` to be accepted later. */
  issue(n: number, grant: string): Json;
  /** Body for a dead refresh token or bad code. */
  error(code: "invalid_grant" | "invalid_code"): { status: number; body: Json };
  /** Any other URL (userinfo, revoke). */
  route?(url: string, req: Request): Response | Promise<Response>;
  clientSecret?: string;
  /** Default true: a refresh token works once. False for providers that keep it (Google). */
  rotate?: boolean;
};

/**
 * A fake authorization server. Codes are bound to the PKCE challenge (when sent); refresh tokens
 * are single-use (`r1`, `r2`, ...) so rotation bugs show up. `approve` plays the user on the consent screen.
 */
export function fakeOAuth(f: FakeOAuth) {
  const s = { codes: new Map<string, string | null>(), live: new Set<string>(), n: 0, requests: [] as Request[] };
  const fail = (code: "invalid_grant" | "invalid_code") => {
    const e = f.error(code);
    return Response.json(e.body, { status: e.status });
  };
  const fetch = (async (url: string, init?: RequestInit) => {
    const req = new Request(url, init);
    s.requests.push(req.clone() as Request);
    if (req.url !== f.tokenUrl) return f.route ? f.route(req.url, req) : new Response("not found", { status: 404 });
    const p = new URLSearchParams(await req.text());
    const basic = req.headers.get("authorization");
    const secret = p.get("client_secret") ?? (basic ? decodeURIComponent(atob(basic.slice(6)).split(":")[1] ?? "") : null);
    if (f.clientSecret !== undefined && secret !== f.clientSecret) return Response.json({ error: "invalid_client" }, { status: 401 });
    const grant = p.get("grant_type") ?? "";
    if (grant === "authorization_code") {
      const code = p.get("code") ?? "";
      if (!s.codes.has(code)) return fail("invalid_code");
      const challenge = s.codes.get(code);
      s.codes.delete(code);
      if (challenge) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(p.get("code_verifier") ?? ""));
        if (challenge !== base64url(new Uint8Array(digest))) return fail("invalid_code");
      }
    } else {
      const rt = p.get("refresh_token") ?? "";
      if (grant !== "refresh_token" || !s.live.has(rt)) return fail("invalid_grant");
      if (f.rotate !== false) s.live.delete(rt);
    }
    const n = ++s.n;
    s.live.add(`r${n}`);
    return Response.json(f.issue(n, grant));
  }) as typeof globalThis.fetch;
  /** The user approves on the provider, which redirects back with a code (bound to the PKCE challenge). */
  const approve = (url: string) => {
    const u = new URL(url);
    const code = crypto.randomUUID();
    s.codes.set(code, u.searchParams.get("code_challenge"));
    return { code, state: u.searchParams.get("state") ?? "" };
  };
  return { s, fetch, approve };
}
