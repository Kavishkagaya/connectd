import { type Credential, type Incoming, NotActive, type SchemaIssue, type Webhook } from "@kavishkagaya/connectd-connections";
import { base64url, type Json } from "@kavishkagaya/connectd-kernel";
import { emit } from "./events.ts";
import { Fail, fault, type Hosted, instanceOf, message, type Reply, type Settings } from "./host.ts";
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
 * With a `subscription` schema too (#54), the app makes them instead, any number per connection:
 * `webhooks.subscribe` (input checked by the schema, registered at once), `webhooks.list`,
 * `webhooks.unsubscribe`; renewed and moved to a new account after re-auth the same way, all removed before revoke.
 */

/** `data` of a `webhook` event. `payload` is null past MAX_PAYLOAD, with `truncated` = its size in bytes. */
export type WebhookData = { topic: string; delivery: string | null; payload: Json | null; truncated?: number };
/** `webhooks.status`. `registers`: the definition registers per connection and `settings.webhooks` is set. `account`: the external ids (JSON) it was registered for. */
export type WebhooksStatus = {
  supported: boolean;
  registers: boolean;
  /** This connection's ingress URL (`/webhooks/:def/:id`); null without `settings.webhooks` or `webhooks` in the definition. */
  url: string | null;
  registration: { hook: Json; renewAt: number | null; account: string | null } | null;
  /** A registration is armed or backing off. */
  pending: boolean;
  /** The definition takes explicit subscriptions (`webhooks.subscribe`), and how many this connection has. */
  subscriptions: number | null;
};
/** One explicit subscription, as `webhooks.list` shows it. `rev` changes on every (re-)registration. */
export type Subscription = { id: string; input: Json; hook: Json; renewAt: number | null; account: string | null; rev: string };
type Receive = { data: WebhookData; external?: { key: string; value: string } };
/**
 * What `register` returned, kept until revoke. `hook` null = the definition registered nothing.
 * `account` = the external ids it was registered for; a re-auth to another account re-registers.
 */
type Stored = { hook: Json; renewAt: number | null; account: string | null };

// One event must fit one stored DO value (2 MB, #24); leave room for the envelope.
// ponytail: past 1 MB the payload is dropped, not stored by reference; receivers re-read it from the provider (proxy). Add blob storage (R2) if that bites.
export const MAX_PAYLOAD = 1_000_000;
const RENEW_MS = 3_600_000;
/** Never renew sooner than this after registering, however short-lived the provider makes it. */
const MIN_RENEW_MS = 60_000;
// ponytail: all of a connection's subscriptions are one stored value, unregistered one by one on revoke; a cell per subscription past this.
const MAX_SUBS = 100;
// ponytail: gives up after 8 attempts (~1h); the next state change or isolate restart tries again.
const RETRY = { baseMs: 30_000, maxAttempts: 8 };
const utf8 = new TextEncoder();

/** An hour before expiry; for short-lived ones at half their life, and never within MIN_RENEW_MS (no loop on a lapsed `expiresAt`). */
const renewAtOf = (now: number, exp: number | undefined) => (exp === undefined ? null : Math.max(exp - RENEW_MS, now + Math.max(MIN_RENEW_MS, (exp - now) / 2)));

const issues = (list: ReadonlyArray<SchemaIssue>): Json =>
  list.map((i) => ({ message: i.message, ...(i.path ? { path: i.path.map((p) => String(typeof p === "object" ? p.key : p)) } : {}) }));

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
          // A topic the definition doesn't list: not an event the app can be typed for. Acknowledged, so the provider doesn't retry it.
          if (def.webhooks.topics && !def.webhooks.topics.includes(inc.topic)) return Response.json({ delivered: 0, ignored: inc.topic });
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
          const rows = (await api.index.byExternal(defId, inc.external.key, inc.external.value)).filter((r) => r.state !== "revoked");
          const replies = await Promise.all(
            rows.map((r) => api.call(instanceOf(defId, r.id), "webhooks.receive", msg as unknown as Json).catch((e): Reply => ({ error: fault(e, "front door", api.platform.log) }))),
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
      const { k, def, bound } = h;
      const w = def.webhooks;
      // Explicit subscriptions replace the one automatic registration.
      const registers = !!(w?.register && !w.subscription && h.settings.webhooks);
      const subscribes = !!(w?.register && w.subscription && h.settings.webhooks);
      // Record version last checked, this isolate. undefined: check once after a restart (covers a lost timer).
      let seen: number | null | undefined;
      /** What `register` returned, kept until revoke. */
      const hookCell = k.cell<Stored>("webhooks.hook");
      /** Set while the sync timer is armed to (re)register or backing off, so `after()` doesn't reset it. */
      const pending = k.cell<boolean>("webhooks.pending");
      /** Register if active and due. A throw retries with backoff; the pending mark clears when it's done or given up. */
      const syncTimer = k.timer("webhooks.sync", {
        async handle() {
          await run();
          await pending.delete();
        },
        retry: RETRY,
        giveUp: async () => void (await pending.delete()),
      });

      async function unregister(cred: Credential, hook: Json) {
        if (hook !== null && w?.unregister) await w.unregister(bound.ctx, cred, hook).catch((e) => h.platform.log("error", "webhooks.unregister.failed", { atom: h.instance, error: message(e) }));
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
        if (!cur || (cur.renewAt !== null && k.now() >= cur.renewAt)) return true;
        const acct = await account();
        return acct !== null && cur.account !== acct;
      }

      async function arm(at: number) {
        await pending.put(true);
        await syncTimer.set(at);
      }

      /** Register if active and due. Runs from the timer only; timers don't overlap. Throws to retry. */
      async function run(): Promise<void> {
        if (!w?.register) return;
        const cur = (await hookCell.read())?.value;
        // Not active: re-auth keeps the hook, revoke removes it.
        if ((await bound.conn.read())?.state !== "active" || !(await due(cur))) return;
        let cred;
        let r;
        const acct = (await account()) ?? cur?.account ?? null;
        try {
          cred = await bound.token();
          r = await w.register(bound.ctx, cred, await endpoint(h), null);
        } catch (e) {
          if (e instanceof NotActive) return;
          throw e;
        }
        const renewAt = renewAtOf(k.now(), r?.expiresAt);
        const next: Stored = { hook: r?.hook ?? null, renewAt, account: acct };
        await hookCell.put(next);
        // Renewed, or re-authed to another account: stop the old subscription.
        // ponytail: after an account change this uses the new account's credential, which the provider may refuse (logged); the old one then lapses or gets 403/410.
        if (cur) await unregister(cred, cur.hook);
        // The renewal timer isn't PENDING: after() re-arms by `due` alone if it's lost.
        if (renewAt !== null) await syncTimer.set(renewAt);
        // Revoked while registering: beforeRevoke found nothing to remove, so undo it here.
        if ((await bound.conn.read())?.state === "revoked" && (await hookCell.take())) {
          await syncTimer.cancel();
          await unregister(cred, next.hook);
        }
      }

      // --- Explicit subscriptions (#54) ---
      type Sub = Omit<Subscription, "id">;
      /**
       * Every subscription of this connection by id, in one cell, so a renewal can't overwrite an
       * unsubscribe. `closed`: revoked; a subscribe that lands after can't add to it.
       */
      const subs = k.cell<{ by: Record<string, Sub>; closed?: true }>("webhooks.subs");
      const all = async () => (await subs.read())?.value.by ?? {};
      /** Due: renewal time passed, or registered for another account than the connection is on now. */
      const subDue = (s: Sub, acct: string | null) => (s.renewAt !== null && k.now() >= s.renewAt) || (acct !== null && s.account !== acct);
      /** Ring at the earliest renewal. Renewals are on-demand too: `after()` re-arms on the next state change if this is lost. */
      async function armRenew() {
        const at = Math.min(...Object.values(await all()).flatMap((s) => (s.renewAt === null ? [] : [s.renewAt])));
        if (Number.isFinite(at)) await renewTimer.set(Math.max(at, k.now()));
      }
      async function registerSub(cred: Credential, input: Json) {
        const r = await w!.register!(bound.ctx, cred, await endpoint(h), input);
        return { hook: r?.hook ?? null, renewAt: renewAtOf(k.now(), r?.expiresAt), rev: crypto.randomUUID() };
      }
      /** Write `f`'s change; a throw (storage) unregisters `hook`, which nothing would record otherwise. */
      async function record(cred: Credential, hook: Json, f: Parameters<typeof subs.update>[0]) {
        try {
          return await subs.update(f);
        } catch (e) {
          await unregister(cred, hook);
          throw e;
        }
      }
      /** The current credential, or null when the connection isn't active. */
      const credential = () =>
        bound.token().catch((e): null => {
          if (e instanceof NotActive) return null;
          throw e;
        });
      /** Renew what's due (expiring, or on the old account after a re-auth). One failing doesn't hold up the rest; then it throws to retry. */
      // ponytail: "moving" a subscription after a re-auth to another account registers the same input
      // (repo) with the new account's credential and deletes the old hook with it too; if the new
      // account can't, the old hook stays (logged) and keeps delivering to this connection's URL.
      async function renewDue() {
        if ((await bound.conn.read())?.state !== "active") return;
        // The account before the credential: a re-auth in between makes a stale label (one extra move), never a wrong one.
        const acct = await account();
        const cred = await credential();
        if (!cred) return;
        let failed: unknown;
        for (const [id, s] of Object.entries(await all())) {
          if (!subDue(s, acct)) continue;
          try {
            const reg = await registerSub(cred, s.input);
            let landed = false;
            await record(cred, reg.hook, (cur) => {
              landed = !!cur && !cur.closed && Object.hasOwn(cur.by, id) && cur.by[id]?.rev === s.rev;
              return landed && cur ? { by: { ...cur.by, [id]: { ...s, ...reg, account: acct ?? s.account } } } : null;
            });
            // Renewed: stop the old one. Unsubscribed or revoked meanwhile: stop the new one.
            await unregister(cred, landed ? s.hook : reg.hook);
          } catch (e) {
            h.platform.log("error", "webhooks.renewal.failed", { atom: h.instance, subscription: id, error: message(e) });
            failed ??= e;
          }
        }
        await armRenew();
        if (failed) throw failed;
      }
      const renewTimer = k.timer("webhooks.renew", { handle: renewDue, retry: RETRY, giveUp: armRenew });
      let subsSeen: number | null | undefined;

      const subscriptionMethods: Record<string, (a: Json) => Promise<Json>> = {
        /** `{ ...input }` (what the definition's `subscription` schema takes): registered now, returned with its id. */
        "webhooks.subscribe": async (a) => {
          if (!subscribes || !w?.subscription) throw new Fail("bad_request", 400, `${def.id} takes no webhook subscriptions${w?.subscription ? " (settings.webhooks is not set)" : ""}`);
          const r = await w.subscription["~standard"].validate(a);
          if (r.issues) throw new Fail("bad_request", 400, "invalid subscription", issues(r.issues));
          // The schema's output is stored as is: it must be JSON.
          const input = r.value as Json;
          if (Object.keys(await all()).length >= MAX_SUBS) throw new Fail("too_many", 409, `at most ${MAX_SUBS} subscriptions per connection`);
          const acct = await account();
          // Not active: the lifecycle's 409, before anything reaches the provider.
          const cred = await bound.token();
          const id = crypto.randomUUID();
          const sub: Sub = { input, ...(await registerSub(cred, input)), account: acct };
          let landed = false;
          await record(cred, sub.hook, (cur) => {
            landed = !cur?.closed;
            return landed ? { by: { ...cur?.by, [id]: sub } } : null;
          });
          // Revoked while registering: beforeRevoke closed the cell, so this one is ours to undo.
          if (!landed) {
            await unregister(cred, sub.hook);
            throw new NotActive("revoked");
          }
          await armRenew();
          return { id, ...sub } satisfies Subscription as unknown as Json;
        },
        "webhooks.list": async () => Object.entries(await all()).map(([id, s]) => ({ id, ...s })) satisfies Subscription[] as unknown as Json,
        /** `{ id }`: removed at the provider with the current credential (best effort), and here. Not active: a 409, kept for after a re-auth. */
        "webhooks.unsubscribe": async (a) => {
          const id = (a as { id?: Json } | null)?.id;
          if (typeof id !== "string") throw new Fail("bad_request", 400, "id must be a string");
          const cred = await bound.token();
          let found: Sub | undefined;
          await subs.update((cur) => {
            found = cur && Object.hasOwn(cur.by, id) ? cur.by[id] : undefined;
            return found && cur ? { ...cur, by: Object.fromEntries(Object.entries(cur.by).filter(([i]) => i !== id)) } : null;
          });
          if (!found) throw new Fail("not_found", 404, "no such subscription");
          await unregister(cred, found.hook);
          return null;
        },
      };

      return {
        methods: {
          ...subscriptionMethods,
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
            await emit(h, m.data as unknown as Json, `webhook.${m.data.topic}`);
            return null;
          },
          /**
           * For the dashboard (#32): the provider-side registration, never the secret. `hook` is what the
           * definition's `register` returned (stored unsealed, so it holds ids, not secrets).
           */
          "webhooks.status": async () => {
            const cur = (await hookCell.read())?.value;
            return {
              supported: !!w,
              registers,
              url: h.settings.webhooks && w ? (await endpoint(h)).url : null,
              registration: cur ? { hook: cur.hook, renewAt: cur.renewAt, account: cur.account } : null,
              pending: !!(await pending.read()),
              subscriptions: subscribes ? Object.keys(await all()).length : null,
            } satisfies WebhooksStatus as unknown as Json;
          },
          /** URL + secret for registering this connection's webhook yourself (GitHub repo hooks through the proxy). API key only. */
          "webhooks.endpoint": async () => (await endpoint(h)) as unknown as Json,
        },

        async after() {
          if (subscribes) {
            // As below: only when the record changed (a re-auth to another account), or once after a restart.
            const v = await bound.conn.version();
            if (v !== subsSeen) {
              const acct = (await bound.conn.read())?.state === "active" ? await account() : undefined;
              if (acct !== undefined && Object.values(await all()).some((s) => subDue(s, acct))) await renewTimer.set(k.now());
              subsSeen = v;
            }
            return;
          }
          if (!registers) return;
          // Most calls change nothing: one small read, no decrypt.
          const v = await bound.conn.version();
          if (v === seen) return;
          // A fresh isolate ignores PENDING: its timer may have been lost.
          if (seen !== undefined && (await pending.read())) return void (seen = v);
          if ((await bound.conn.read())?.state === "active" && (await due((await hookCell.read())?.value))) await arm(k.now());
          // Only after the check landed: a throw above retries it on the next call.
          seen = v;
        },

        async beforeRevoke() {
          if (subscribes) {
            const cred = await credential();
            await renewTimer.cancel();
            // Close it in the same write: a subscribe still registering finds it closed and undoes its own hook.
            let taken: Sub[] = [];
            await subs.update((cur) => {
              taken = Object.values(cur?.by ?? {});
              return { by: {}, closed: true };
            });
            if (taken.length && !cred) return h.platform.log("warn", "webhooks.not_unregistered", { atom: h.instance, reason: "no credential (not active)", subscriptions: taken.length });
            for (const s of taken) if (cred) await unregister(cred, s.hook);
            return;
          }
          if (!registers) return;
          // The credential first: if that fails transiently (a refresh), the hook stays stored and the error is logged.
          let cred: Credential | null = null;
          try {
            cred = await bound.token();
          } catch (e) {
            if (!(e instanceof NotActive)) throw e;
          }
          await syncTimer.cancel();
          await pending.delete();
          const cur = await hookCell.take();
          if (cur?.hook == null) return;
          // ponytail: one best-effort try, no retry: after the revoke there's no credential to retry with.
          // A leftover subscription gets 410 from the per-connection route (and Google channels lapse).
          if (!cred) return h.platform.log("warn", "webhooks.not_unregistered", { atom: h.instance, reason: "no credential (not active)", hook: cur.hook });
          await unregister(cred, cur.hook);
        },
      };
    },
  };
}
