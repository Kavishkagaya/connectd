import type { Json } from "@openconnect/kernel";
import type { Api, Connection } from "./builder.ts";
import type { Credential, State } from "./lifecycle.ts";

/**
 * Actions (#54): what an app does with a connection, one per file, written next to the connection
 * they run on (trigger.dev-task style), not inside it.
 *
 *   export const starRepo = action("starRepo", github)
 *     .input(z.object({ repo: z.string() }))
 *     .run(({ api }, { repo }) => api.fetch(`/user/starred/${repo}`, { method: "PUT" }));
 *
 *   export const syncIssues = action("syncIssues", github)
 *     .every(HOUR)
 *     .run(async ({ api, store }) => { ... });
 *
 * Each runs inside its connection's instance, so `api` is that one user's, already authenticated.
 * The app calls one with `POST /connections/:def/:id/actions/:name`; `.every(ms)` and `.on(state)`
 * runs have no caller, so their results go out as `action.completed` / `action.failed` events.
 */

/** Standard Schema v1 (standardschema.dev): zod, valibot and arktype implement it, so we depend on none. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => SchemaResult<Output> | Promise<SchemaResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}
export type SchemaIssue = { readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined };
export type SchemaResult<O> = { readonly value: O; readonly issues?: undefined } | { readonly issues: ReadonlyArray<SchemaIssue> };
type InputOf<S> = S extends StandardSchemaV1<infer I, unknown> ? I : never;
type OutputOf<S> = S extends StandardSchemaV1<unknown, infer O> ? O : never;

/** Per-connection storage shared by its actions (a sync cursor). Values are JSON. */
export type Store = {
  get<T extends Json = Json>(key: string): Promise<T | null>;
  set(key: string, value: Json): Promise<void>;
  delete(key: string): Promise<void>;
};

/** What `run` gets. `api` only when the connection has `.api()`. */
export type ActionCtx<Conn> =
  Conn extends Connection<string, infer C, infer M, infer A>
    ? {
        config: C;
        fetch: typeof fetch;
        now(): number;
        /** Which connection this run is for. */
        connection: { definition: string; id: string };
        /** The connection's identity (`.identity()`), null if it has none. */
        identity: M | null;
        /** The current credential, refreshed if it's due. */
        token(): Promise<Credential>;
        store: Store;
      } & (true extends A ? { api: Api } : unknown)
    : never;

/** How a run started: an app call, the `.every` timer, or the `.on` state. */
export type Trigger = "call" | "every" | "on";

/** What the runtime runs (read with `actionOf`). */
export type ActionSpec = {
  id: string;
  /** The connection's definition id. */
  connection: string;
  input?: StandardSchemaV1;
  every?: number;
  on?: State;
  run(ctx: unknown, input: unknown): Promise<Json>;
};

const ACTION = Symbol.for("openconnect.action");

/** A built action. `I`/`O` are its input and output, for the typed client. */
export type Action<Id extends string = string, Conn extends Connection = Connection, I = unknown, O extends Json = Json> = {
  readonly id: Id;
  readonly connection: Conn;
  readonly [ACTION]: ActionSpec;
  /** Types only. */
  readonly "~io"?: { input: I; output: O };
};

export type AnyAction = Action<string, any, any, any>;

export const actionOf = (a: AnyAction): ActionSpec => a[ACTION];
export const isAction = (v: unknown): v is AnyAction => typeof v === "object" && v !== null && ACTION in v;

type Run<Conn, I, O> = (ctx: ActionCtx<Conn>, input: I) => Promise<O> | O;
/** `void` (nothing returned) comes back as null. */
type Out<O> = O extends undefined | void ? null : O;

/** After `.input()`: input actions are called by the app only, so no triggers. */
interface WithInput<Id extends string, Conn extends Connection, I, In> {
  run<O extends Json | void>(run: Run<Conn, I, O>): Action<Id, Conn, In, Out<O>>;
}

/** After a trigger: more triggers, then `run`. */
interface Scheduled<Id extends string, Conn extends Connection> {
  /** Run every `ms` while the connection is active (first run `ms` after it becomes active). */
  every(ms: number): Scheduled<Id, Conn>;
  /** Run once each time the connection enters `state` (`active`: after every login or re-auth). */
  on(state: State): Scheduled<Id, Conn>;
  run<O extends Json | void>(run: Run<Conn, undefined, O>): Action<Id, Conn, undefined, Out<O>>;
}

interface Start<Id extends string, Conn extends Connection> extends Scheduled<Id, Conn> {
  /** What the app passes, checked by the runtime before `run` (a 400 with the schema's issues otherwise). */
  input<S extends StandardSchemaV1>(schema: S): WithInput<Id, Conn, OutputOf<S>, InputOf<S>>;
}

// Ids end up in stored names (`actions.<id>.*`) and URLs.
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Start an action on `connection`. Its id is unique per connection. */
export function action<const Id extends string, Conn extends Connection>(id: Id, connection: Conn): Start<Id, Conn> {
  if (!ID.test(id)) throw new Error(`action id ${JSON.stringify(id)}: letters, digits, _ and - only`);
  const make = (s: Omit<ActionSpec, "run" | "id" | "connection">): any => ({
    input: (input: StandardSchemaV1) => make({ ...s, input }),
    every(ms: number) {
      if (!(Number.isFinite(ms) && ms >= 1000)) throw new Error(`action ${id}: every() takes at least 1000 ms`);
      return make({ ...s, every: ms });
    },
    on: (on: State) => make({ ...s, on }),
    run: (run: (ctx: unknown, input: unknown) => unknown): AnyAction => ({
      id,
      connection,
      [ACTION]: { ...s, id, connection: connection.id, run: async (ctx, input) => ((await run(ctx, input)) ?? null) as Json },
    }),
  });
  return make({});
}
