import type { Action, AnyAction, Connection } from "@openconnect/connections";
import type { Json } from "@openconnect/kernel";

/**
 * The project's connections and their actions, for the typed client (#54). Empty here; the CLI's
 * generated `.openconnect/registry.d.ts` fills it in (`openconnect dev`, `deploy`, `types`):
 *
 *   declare module "@openconnect/sdk" {
 *     interface Registry extends RegistryOf<typeof config, Exports<typeof m0 | typeof m1>> {}
 *   }
 *
 * With it, `oc.connection("github", id)` takes only known ids, and `.actions`, `.status()` and
 * `.webhooks.subscribe()` are typed from the definitions. Without it, everything is a string and Json.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by the generated registry.
export interface Registry {}

/** Every export of each module in a union (discovered files). */
export type Exports<M> = M extends unknown ? M[keyof M] : never;

type ProjectOf<Cfg> = Cfg extends (...a: never[]) => infer P ? P : Cfg;
type Listed<P> = (P extends { definitions: readonly (infer D)[] } ? D : never) | (P extends { actions?: readonly (infer A)[] } ? A : never);
/** Builders with a literal id; plain definitions (`defineConnection`, id: string) aren't typed. */
type Conns<I> = I extends Connection<infer Id, any, any, any> ? (string extends Id ? never : I) : never;
type Acts<I> = I extends AnyAction ? I : never;

/** A listed definition the registry can't type: a plain one, or a builder whose id is just `string`. */
type Plain<I> = I extends AnyAction ? never : I extends Connection<infer Id, any, any, any> ? (string extends Id ? I : never) : I;

/**
 * The registry of a project: `Cfg` is its config's type (`typeof config`), `Extra` what folder
 * discovery found. When the config lists definitions it can't type, `"~untyped"` marks it, and the
 * client takes any id besides the typed ones (untyped, Json).
 */
export type RegistryOf<Cfg, Extra = never> = RegistryFrom<Listed<ProjectOf<Cfg>> | Extra> &
  ([Plain<Listed<ProjectOf<Cfg>>>] extends [never] ? unknown : { "~untyped": true });
type RegistryFrom<I> = {
  [C in Conns<I> as C["id"]]: { connection: C; actions: { [A in Acts<I> as A["connection"]["id"] extends C["id"] ? A["id"] : never]: A } };
};

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
        [N in keyof A]: A[N] extends Action<any, any, infer I, infer O>
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
