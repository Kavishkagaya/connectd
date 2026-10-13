import type { Incoming, Webhook } from "@openconnect/connections";
import { backoff, base64url, type Credential, type Json, NotActive, type RetryPayload } from "@openconnect/kernel";
import { findByExternal } from "./directory.ts";
import { emit } from "./events.ts";
import { Fail, fault, type Hosted, instanceOf, type Reply, type Settings } from "./host.ts";
import { reply } from "./http.ts";
import type { Extension } from "./runtime.ts";

/**
 * Provider webhooks in, `webhook` events out (through #24's ordered outbox):
 *
 *   POST /webhooks/:def/:id   one connection's webhook, signed with that connection's own secret
 *   POST /webhooks/:def       one URL for the whole app (Slack Events API): routed by the external
 *                             id in the payload, fanned out to every connection with it (#26)
 *
 * Both are public: the provider's signature is the authentication, checked by the definition
 * (`webhooks.verify`) in the Worker before anything reaches a connection. Definitions with
 * `webhooks.register` also get a provider-side subscription per connection, created when the
 * connection goes active (durable timer, retried), renewed before it lapses, removed before revoke.
 */

/** `data` of a `webhook` event. `payload` is null past MAX_PAYLOAD, with `truncated` = its size in bytes. */
export type WebhookData = { topic: string; delivery: string | null; payload: Json | null; truncated?: number };
type Receive = { data: WebhookData; external?: { key: string; value: string } };
/**
 * What `register` returned, kept until revoke. `hook` null = the definition registered nothing.
 * `account` = the external ids it was registered for; a re-auth to another account re-registers.
 */
type Stored = { hook: Json; renewAt: number | null; account: string | null };

// One event must fit one stored DO value (2 MB, #24); leave room for the envelope.
// ponytail: past 1 MB the payload is dropped, not stored by reference; receivers re-read it from the provider (proxy). Add blob storage (R2) if that bites.
export const MAX_PAYLOAD = 1_000_000;
const KEY = "webhooks.hook";
/** Set while a `webhooks.sync` timer is armed to (re)register or backing off, so `after()` doesn't reset it. */
const PENDING = "webhooks.pending";
const TIMER = "webhooks.sync";
const RENEW_MS = 3_600_000;
/** Never renew sooner than this after registering, however short-lived the provider makes it. */
const MIN_RENEW_MS = 60_000;
const BACKOFF = { baseMs: 30_000, maxAttempts: 8 };
const utf8 = new TextEncoder();

/** This connection's webhook secret: derived (HMAC of the instance key), so nothing to store and each connection's differs. */
async function secretOf(s: Settings, instance: string): Promise<string | null> {
  if (!s.webhooks) return null;
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", s.webhooks.key, utf8.encode(`webhook:${instance}`))));
}

async function endpoint(h: Hosted) {
  const w = h.settings.webhooks;
  const secret = await secretOf(h.settings, h.instance);
  if (!w || !secret) throw new Fail("not_configured", 503, "settings.webhooks is not set");
  return { url: `${w.url.replace(/\/+$/, "")}/${encodeURIComponent(h.def.id)}/${encodeURIComponent(h.id)}`, secret };
}

function data(inc: Exclude<Incoming, { reply: Json }>): WebhookData {
  const base = { topic: inc.topic, delivery: inc.delivery ?? null };
  const size = utf8.encode(JSON.stringify(inc.payload)).length;
  return size > MAX_PAYLOAD ? { ...base, payload: null, truncated: size } : { ...base, payload: inc.payload };
}

/** Fan-out replies that a retry wouldn't change: revoked since the index copy, or re-authed to another account (stale row). */
const skip = (r: Reply) => "error" in r && ["gone", "not_found", "forbidden"].includes(r.error.code);

export function webhooks(): Extension {
  return {
    // Only the route may hand a connection a webhook; it's verified there.
    internal: ["webhooks.receive"],
    routes: {
      webhooks: {
        public: true,
        async fetch(req, api, [defId, id, ...rest]) {
          if (!defId || rest.length) throw new Fail("not_found", 404, "no such route");
          const def = Object.hasOwn(api.definitions, defId) ? api.definitions[defId] : undefined;
          if (!def?.webhooks) throw new Fail("not_found", 404, `no webhooks for ${defId}`);
          if (req.method !== "POST") throw new Fail("method_not_allowed", 405, "POST only");
          if (!Object.hasOwn(api.settings.config, defId)) throw new Fail("not_configured", 503, `no config for ${defId}`);
          const w: Webhook = { headers: req.headers, body: await req.text() };
          const secret = id === undefined ? null : await secretOf(api.settings, instanceOf(defId, id));
          if (!(await def.webhooks.verify({ config: api.settings.config[defId], now: api.now }, w, secret))) throw new Fail("unauthorized", 401, "bad webhook signature");
          let inc: Incoming;
          try {
            inc = def.webhooks.parse(w);
          } catch (e) {
            throw new Fail("bad_request", 400, `unreadable webhook: ${e instanceof Error ? e.message : String(e)}`);
          }
          if ("reply" in inc) return Response.json(inc.reply);
          // Accepting and dropping would lose it silently; a 503 makes the provider retry or flag it.
          if (!api.settings.events) throw new Fail("not_configured", 503, "settings.events is not set: nowhere to deliver webhooks");
          const msg = { data: data(inc), ...(inc.external ? { external: inc.external } : {}) } satisfies Receive;

          if (id !== undefined) {
            const r = await api.call(instanceOf(defId, id), "webhooks.receive", msg as unknown as Json);
            return "error" in r ? reply(r) : Response.json({ delivered: 1 });
          }

          if (!inc.external) throw new Fail("bad_request", 400, `${defId} webhook names no account to route by`);
          if (!api.index) throw new Fail("not_configured", 503, "app-level webhooks need the connection index (directory)");
          // Revoked connections stay in the index (terminal, never deleted); a reconnect is a new one.
          const rows = (await findByExternal(api.index, defId, inc.external.key, inc.external.value)).filter((r) => r.state !== "revoked");
          const replies = await Promise.all(
            rows.map((r) => api.call(instanceOf(defId, r.id), "webhooks.receive", msg as unknown as Json).catch((e): Reply => ({ error: fault(e, "worker") }))),
          );
          // Any other failure: answer 5xx so the provider retries. The connections that took it get it twice;
          // receivers dedupe on `delivery`.
          const failed = replies.filter((r) => "error" in r && !skip(r)).length;
          if (failed) throw new Fail("delivery_failed", 503, `${failed} of ${rows.length} connections did not take the webhook`);
          return Response.json({ delivered: replies.filter((r) => "ok" in r).length });
        },
      },
    },

    connection: (h) => {
      const { d, def, bound } = h;
      const w = def.webhooks;
      const registers = !!(w?.register && h.settings.webhooks);
      // Record version last checked, this isolate. undefined: check once after a restart (covers a lost timer).
      let seen: number | null | undefined;

      async function unregister(cred: Credential, hook: Json) {
        if (hook !== null && w?.unregister) await w.unregister(bound.ctx, cred, hook).catch((e) => console.error("webhook unregister", h.instance, e));
      }

      /** The account (external ids) the connection is on now; null when it has none or the hook throws. */
      async function account(): Promise<string | null> {
        const meta = await bound.metadata();
        try {
          return meta !== null && def.external ? JSON.stringify(def.external(meta)) : null;
        } catch {
          return null;
        }
      }

      /** Nothing registered, due for renewal, or registered for another account (an unknown account, null, is no change). */
      async function due(cur: Stored | undefined) {
        if (!cur || (cur.renewAt !== null && d.now() >= cur.renewAt)) return true;
        const acct = await account();
        return acct !== null && cur.account !== acct;
      }

      async function arm(attempt: number, at: number) {
        await d.store.put(PENDING, true);
        await d.timer.set(TIMER, at, { attempt, data: null });
      }

      /** Register if active and due. Runs from the timer only; timers don't overlap. */
      async function sync(attempt: number) {
        let retrying = false;
        try {
          retrying = await run(attempt);
        } finally {
          // Whatever happened, unless a retry is armed: leave nothing that stops after() from re-arming.
          if (!retrying) await d.store.delete(PENDING);
        }
      }

      /** True if it armed a retry. */
      async function run(attempt: number): Promise<boolean> {
        if (!w?.register) return false;
        const cur = (await d.store.get(KEY))?.value as unknown as Stored | undefined;
        // Not active: re-auth keeps the hook, revoke removes it.
        if ((await bound.conn.read())?.state !== "active" || !(await due(cur))) return false;
        let cred;
        let r;
        const acct = (await account()) ?? cur?.account ?? null;
        try {
          cred = await bound.token();
          r = await w.register(bound.ctx, cred, await endpoint(h));
        } catch (e) {
          if (e instanceof NotActive) return false;
          console.error("webhook register failed", h.instance, attempt, e);
          // ponytail: gives up after 8 attempts (~1h); the next state change or isolate restart tries again.
          if (attempt + 1 >= BACKOFF.maxAttempts) return false;
          await arm(attempt + 1, d.now() + backoff(attempt, BACKOFF));
          return true;
        }
        // An hour before expiry; for short-lived ones at half their life, and never within MIN_RENEW_MS (no loop on a lapsed `expiresAt`).
        const exp = r?.expiresAt;
        const renewAt = exp === undefined ? null : Math.max(exp - RENEW_MS, d.now() + Math.max(MIN_RENEW_MS, (exp - d.now()) / 2));
        const next: Stored = { hook: r?.hook ?? null, renewAt, account: acct };
        await d.store.put(KEY, next as unknown as Json);
        // Renewed, or re-authed to another account: stop the old subscription.
        // ponytail: after an account change this uses the new account's credential, which the provider may refuse (logged); the old one then lapses or gets 403/410.
        if (cur) await unregister(cred, cur.hook);
        // The renewal timer isn't PENDING: after() re-arms by `due` alone if it's lost.
        if (renewAt !== null) await d.timer.set(TIMER, renewAt, { attempt: 0, data: null });
        // Revoked while registering: beforeRevoke found nothing to remove, so undo it here.
        if ((await bound.conn.read())?.state === "revoked" && (await d.store.take(KEY))) {
          await d.timer.cancel(TIMER);
          await unregister(cred, next.hook);
        }
        return false;
      }

      return {
        methods: {
          /** From the route only (internal): one verified webhook into this connection's event outbox. */
          "webhooks.receive": async (a) => {
            const m = a as unknown as Receive;
            const s = await bound.conn.read();
            if (!s) throw new Fail("not_found", 404, "no such connection");
            if (s.state === "revoked") throw new Fail("gone", 410, "connection is revoked");
            // The payload names an account: it must be this connection's, or a webhook signed with an
            // app-wide secret could be replayed into another tenant's connection.
            if (m.external) {
              const meta = await bound.metadata();
              const ids = meta !== null && def.external ? def.external(meta) : {};
              if (ids[m.external.key] !== m.external.value) throw new Fail("forbidden", 403, "webhook is for another account");
            }
            await emit(h, m.data as unknown as Json);
            return null;
          },
          /** URL + secret for registering this connection's webhook yourself (GitHub repo hooks through the proxy). API key only. */
          "webhooks.endpoint": async () => (await endpoint(h)) as unknown as Json,
        },

        async onTimer(name, payload) {
          if (name !== TIMER) return false;
          await sync((payload as unknown as RetryPayload | null)?.attempt ?? 0);
          return true;
        },

        async after() {
          if (!registers) return;
          // Most calls change nothing: one small read, no decrypt.
          const v = await bound.conn.version();
          if (v === seen) return;
          // A fresh isolate ignores PENDING: its timer may have been lost.
          if (seen !== undefined && (await d.store.get(PENDING))) return void (seen = v);
          if ((await bound.conn.read())?.state === "active" && (await due((await d.store.get(KEY))?.value as unknown as Stored | undefined)))
            await arm(0, d.now());
          // Only after the check landed: a throw above retries it on the next call.
          seen = v;
        },

        async beforeRevoke() {
          if (!registers) return;
          // The credential first: if that fails transiently (a refresh), the hook stays stored and the error is logged.
          let cred: Credential | null = null;
          try {
            cred = await bound.token();
          } catch (e) {
            if (!(e instanceof NotActive)) throw e;
          }
          await d.timer.cancel(TIMER);
          await d.store.delete(PENDING);
          const cur = (await d.store.take(KEY)) as unknown as Stored | null;
          if (cur?.hook == null) return;
          // ponytail: one best-effort try, no retry: after the revoke there's no credential to retry with.
          // A leftover subscription gets 410 from the per-connection route (and Google channels lapse).
          if (!cred) return console.error("webhook not unregistered: connection has no credential (not active)", h.instance, cur.hook);
          await unregister(cred, cur.hook);
        },
      };
    },
  };
}
