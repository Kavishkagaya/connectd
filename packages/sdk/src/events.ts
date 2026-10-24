import type { ConnectionEvent } from "@openconnect/runtime";
import { verify } from "@openconnect/runtime/signature";
import type { Connection } from "./client.ts";
import type { EventFor, EventsOf, Registry } from "./registry.ts";

/**
 * The receiving end of event delivery (#24): verify the Standard Webhooks signature, parse the
 * `ConnectionEvent`, run its handlers. Delivery is at least once and retried until a 2xx, so the
 * answer is the contract: 204 handled (or nothing to do), 401 bad signature, 500 a handler threw.
 *
 *   const ev = oc.events({ secret: process.env.OPENCONNECT_EVENTS_SECRET });
 *   ev.on("connection.reauth_required", async (e, conn) => notify(e.connection.id));
 *   ev.on("webhook.push", (e) => ...); ev.on("syncIssues.completed", (e) => e.data.output);
 *   export const POST = (req: Request) => ev.handle(req); // Next, Hono `c.req.raw`, Bun, Workers, Deno
 */

/** The event types the app can get: the registry's (`connection.active`, `webhook.push`, `syncIssues.completed`, own events). */
export type EventType<R = Registry> = EventsOf<R>["type"];
/** The event for one `type`: `connection.active` gives a `LifecycleEvent`, `webhook.push` a `WebhookEvent`, typed from the registry. */
export type EventOf<T extends string, R = Registry> = EventFor<R, T>;
export type Handler<E> = (event: E, connection: Connection) => unknown;

/** Remembers handled `webhook-id`s. A `Set<string>` will do in dev; use a shared store with a TTL in production. */
export type Dedupe = { has(id: string): boolean | Promise<boolean>; add(id: string): unknown };

export type EventsOptions = {
  /** The `whsec_...` secret from the runtime's `settings.events`. */
  secret: string;
  /** Skip events already handled. Checked before the handlers, recorded after they all succeed. */
  dedupe?: Dedupe;
  /** Max clock skew for `webhook-timestamp` (default 300s). */
  toleranceSec?: number;
  /** Clock for the timestamp check (default `Date.now`); tests pass a fake one. */
  now?: () => number;
};

export function events<R = Registry>(o: EventsOptions, connection: (def: string, id: string) => Connection) {
  const handlers = new Map<string, Handler<ConnectionEvent>[]>();
  const answer = (status: number, message?: string) => (message ? Response.json({ error: message }, { status }) : new Response(null, { status }));

  return {
    /** Run `handler` for every event of `type` (`"*"`: all events). Several per type run in order. */
    on<T extends EventType<R> | "*">(type: T, handler: Handler<T extends "*" ? EventsOf<R> : EventFor<R, T>>) {
      handlers.set(type, [...(handlers.get(type) ?? []), handler as Handler<ConnectionEvent>]);
      return this;
    },

    /** Handle one delivery. Pass the request untouched: the signature covers the raw body. */
    async handle(req: Request): Promise<Response> {
      if (req.method !== "POST") return answer(405, "POST only");
      const body = await req.text();
      if (!(await verify(o.secret, req.headers, body, { now: (o.now ?? Date.now)(), toleranceSec: o.toleranceSec ?? 300 }))) return answer(401, "bad signature");
      // verify checked it's there.
      const id = req.headers.get("webhook-id") as string;
      if (await o.dedupe?.has(id)) return answer(204);
      let e: ConnectionEvent;
      try {
        e = JSON.parse(body) as ConnectionEvent;
      } catch {
        // Can't come from a genuine runtime (it signed this body). Not a 2xx, so it would park the connection's later events.
        return answer(400, "body is not JSON");
      }
      try {
        const conn = connection(e.connection.definition, e.connection.id);
        for (const h of [...(handlers.get(e.type) ?? []), ...(handlers.get("*") ?? [])]) await h(e, conn);
      } catch (err) {
        // Not a 2xx, so the runtime keeps the event and retries it (same webhook-id), in order.
        console.error("openconnect event handler failed", id, err);
        return answer(500, "handler failed");
      }
      await o.dedupe?.add(id);
      return answer(204);
    },
  };
}

export type Events<R = Registry> = ReturnType<typeof events<R>>;
