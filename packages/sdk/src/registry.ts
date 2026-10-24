import type { Action, Connection } from "@openconnect/connections";
import type { Json } from "@openconnect/kernel";
import type { ConnectionEvent, LifecycleEvent, WebhookData } from "@openconnect/runtime";

/**
 * The project's connections and their actions, for the typed client (#54). Empty here; the CLI's
 * generated `.openconnect/registry.d.ts` fills it in (`openconnect dev`, `deploy`, `types`), one
 * entry per connection folder, named after it:
 *
 *   declare module "@openconnect/sdk" {
 *     interface Registry extends RegistryOf<typeof config> {
 *       github: Entry<typeof c0, { starRepo: typeof a0 }>;
 *     }
 *   }
 *
 * With it, `oc.connection("github", id)` takes only known ids, and `.actions`, `.status()` and
 * `.webhooks.subscribe()` are typed from the folder's files. Without it, everything is a string and Json.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by the generated registry.
export interface Registry {}

/** One connection: its `connection.ts` default export and its actions by name (`actions/<name>.ts`). */
export type Entry<C, A = {}> = { connection: C; actions: A };

type ProjectOf<Cfg> = Cfg extends (...a: never[]) => infer P ? P : Cfg;
type Listed<P> = P extends { definitions?: readonly (infer D)[] } ? D : never;
/** Builders with a literal id; plain definitions (`defineConnection`, id: string) aren't typed. */
type Conns<I> = I extends Connection<infer Id, any, any, any> ? (string extends Id ? never : I) : never;
/** A listed definition the registry can't type: a plain one, or a builder whose id is just `string`. */
type Plain<I> = I extends Connection<infer Id, any, any, any> ? (string extends Id ? I : never) : I;
type ActionsFor<P, Id> = P extends { actions?: infer A } ? (Id extends keyof NonNullable<A> ? NonNullable<A>[Id] : {}) : {};

/**
 * The connections a config lists itself (`definitions`, with `actions: { <id>: { <name>: action } }`),
 * keyed by id; folders add theirs on top. When the config lists definitions it can't type,
 * `"~untyped"` marks it, and the client takes any id besides the typed ones (untyped, Json).
 */
export type RegistryOf<Cfg> = RegistryFrom<ProjectOf<Cfg>>;
type RegistryFrom<P> = { [C in Conns<Listed<P>> as C["id"]]: Entry<C, ActionsFor<P, C["id"]>> } & ([Plain<Listed<P>>] extends [never] ? unknown : { "~untyped": true });

/** The ids the client takes: the registry's, or any string without one. */
export type Known<R> = [keyof R] extends [never]
  ? string
  : "~untyped" extends keyof R
    ? Exclude<Extract<keyof R, string>, "~untyped"> | (string & {})
    : Extract<keyof R, string>;
export type EntryOf<R, K> = K extends "~untyped" ? never : K extends keyof R ? R[K] : never;

/** The connection's identity (`.identity()`), Json without a registry. */
export type IdentityOf<E> = [E] extends [never] ? Json : E extends { connection: Connection<any, any, infer M, any> } ? M : Json;

/** Method syntax (bivariant), so a typed connection's actions fit the untyped `Connection`'s. */
type Untyped = { call(input?: Json): Promise<Json> }["call"];

/** `actions.<name>(input)`: typed from each action's input schema and `run`'s output; optional input stays optional. */
export type ActionsOf<E> = [E] extends [never]
  ? Record<string, Untyped>
  : E extends { actions: infer A }
    ? {
        [N in keyof A]: A[N] extends Action<infer I, infer O>
          ? [I] extends [undefined]
            ? () => Promise<O>
            : undefined extends I
              ? (input?: I) => Promise<O>
              : (input: I) => Promise<O>
          : never;
      }
    : never;

/** What `webhooks.subscribe` takes: the definition's subscription schema's input. */
// ponytail: `.webhooks()` carries `S` only as the last step of the builder; called earlier, subscribe takes Json.
export type SubscriptionOf<E> = [E] extends [never] ? Json : E extends { connection: { "~subscription"?: infer S } } ? (unknown extends S ? Json : S) : Json;

type Base<K> = Omit<LifecycleEvent, "type" | "data" | "connection"> & { connection: { definition: K; id: string } };
type OutOf<S> = S extends { readonly "~standard": { readonly types?: { readonly output: infer O } | undefined } } ? O : Json;
type TopicsOf<C> = C extends { readonly "~topics"?: infer T } ? (unknown extends T ? string : Extract<T, string>) : string;
type OwnOf<C> = C extends { readonly "~events"?: infer E } ? (unknown extends E ? {} : NonNullable<E>) : {};
type ActionEvents<K, N extends string, O> =
  | (Base<K> & { type: `${N}.completed`; data: { action: N; trigger: "every" | "on"; output: O } })
  | (Base<K> & { type: `${N}.failed`; data: { action: N; trigger: "every" | "on"; error: string; attempt: number } });

/**
 * Every event one connection sends the app (#54), `connection.definition` its id: `connection.<state>`,
 * `webhook.<topic>` (its `.webhooks({ topics })`, any topic without), `<action>.completed` / `.failed`
 * with the action's output, and its own `.events({ ... })` with each schema's output.
 */
export type EventsOfEntry<K extends string, E> = E extends { connection: infer C; actions: infer A }
  ?
      | (Base<K> & Pick<LifecycleEvent, "type" | "data">)
      | (Base<K> & { type: `webhook.${TopicsOf<C>}`; data: WebhookData })
      | { [N in Extract<keyof A, string>]: ActionEvents<K, N, A[N] extends Action<any, infer O> ? O : Json> }[Extract<keyof A, string>]
      | { [N in Extract<keyof OwnOf<C>, string>]: Base<K> & { type: N; data: OutOf<OwnOf<C>[N]> } }[Extract<keyof OwnOf<C>, string>]
  : never;

/** The events the app can get: the registry's, typed; any `ConnectionEvent` without one (or with untyped definitions). */
export type EventsOf<R> = [keyof R] extends [never]
  ? ConnectionEvent
  : { [K in Exclude<Extract<keyof R, string>, "~untyped">]: EventsOfEntry<K, R[K]> }[Exclude<Extract<keyof R, string>, "~untyped">] | ("~untyped" extends keyof R ? ConnectionEvent : never);

/**
 * The events of one `type`. A pattern type (`webhook.${string}`) counts when `T` fits it; an own
 * event's plain `string` only for a name without dots (theirs never have one).
 */
export type EventFor<R, T extends string> = EventsOf<R> extends infer E
  ? E extends { type: infer U extends string }
    ? T extends U
      ? string extends U
        ? T extends `${string}.${string}`
          ? never
          : E
        : E & { type: T }
      : never
    : never
  : never;
