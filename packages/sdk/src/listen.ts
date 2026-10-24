import type { EventType, Handler } from "./events.ts";
import type { EventFor, EventsOf, Known, Registry } from "./registry.ts";

/**
 * A connection folder's `events.ts` (#54, app side): the app's handlers for that connection's
 * events. It runs in the app, never in the runtime's Worker:
 *
 *   // src/oc/github/events.ts
 *   export default listen("github")
 *     .on("connection.active", async (e, conn) => welcome(e.connection.id))
 *     .on("webhook.push", (e) => sync(e.data.payload));
 *
 * Typed from the registry like `oc.events().on()`, but only this connection's events. The CLI
 * collects the folders' listeners into `.connectd/app.ts` for `connectd({ listeners })`.
 */
export type Listener = { readonly id: string; readonly handlers: readonly (readonly [string, Handler<never>])[] };

/** One entry of the registry (every event type stays possible without one). */
type Only<R, K> = [keyof R] extends [never] ? R : K extends keyof R ? Pick<R, K> : {};

type Listening<R> = Listener & {
  /** Run `handler` for this connection's events of `type` (`"*"`: all of them). Several per type run in order. */
  on<T extends EventType<R> | "*">(
    type: T & (T extends "*" ? unknown : [EventFor<R, T>] extends [never] ? never : unknown),
    handler: Handler<T extends "*" ? EventsOf<R> : EventFor<R, T>>,
  ): Listening<R>;
};

function make<R>(id: string, handlers: Listener["handlers"]): Listening<R> {
  return { id, handlers, on: (type, handler) => make<R>(id, [...handlers, [type, handler as Handler<never>]]) };
}

/** Start the listeners of connection `id` (its folder's name). `R`: the registry, for tests. */
export function listen<K extends Known<R>, R = Registry>(id: K): Listening<Only<R, K>> {
  return make(id, []);
}

export const isListener = (v: unknown): v is Listener =>
  typeof v === "object" && v !== null && typeof (v as Listener).id === "string" && Array.isArray((v as Listener).handlers);
