import type { Json } from "@kavishkagaya/connectd-kernel";
import type { Api, Connection } from "./builder.ts";
import type { Credential, State } from "./lifecycle.ts";

/**
 * Actions (#54): what an app does with a connection, one file each, in the connection's folder
 * (like Nango functions). The file name is the action's name, the folder its connection:
 *
 *   // src/oc/github/actions/starRepo.ts
 *   export default action({
 *     input: z.object({ repo: z.string() }),
 *     run: async (conn, { repo }) => ({ status: (await conn.api.fetch(`/user/starred/${repo}`, { method: "PUT" })).status }),
 *   });
 *
 *   // src/oc/github/actions/syncIssues.ts
 *   export default action({ every: HOUR, run: async (conn) => { ... } });
 *
 * Each runs inside its connection's instance, so `conn.api` is that one user's, already
 * authenticated. The app calls one with `oc.connection("github", id).actions.starRepo(input)`;
 * `every` and `on` runs have no caller, so their results go out as `<name>.completed` /
 * `<name>.failed` events (`syncIssues.completed`).
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

/**
 * What `run` gets. Typed for any connection (`config` and `identity` untyped, `api` present); for
 * exact types annotate it: `run: async (conn: ActionCtx<typeof github>) => ...`. `api` throws on a
 * connection without `.api()`.
 */
export type ActionCtx<Conn = Connection> =
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
        /**
         * Send one of the connection's own events (`.events({ ... })`) to the app: checked against its
         * schema now (a throw otherwise); sent when the run succeeds, before its `.completed`. A run
         * that throws sends none, so a retried run doesn't send them twice.
         */
        emit: EmitOf<Conn>;
      } & (true extends A ? { api: Api } : unknown)
    : never;

type Emit = { emit(name: string, data?: Json): Promise<void> }["emit"];
/** Typed from `.events()`; no name for a builder without them; any name and Json for an unannotated `conn`. */
export type EmitOf<Conn> = "~events" extends keyof Conn
  ? Conn extends { readonly "~events"?: infer E }
    ? <N extends Extract<keyof NonNullable<E>, string>>(name: N, data: InputOf<NonNullable<E>[N]>) => Promise<void>
    : Emit
  : Conn extends { events(...a: never[]): unknown }
    ? (name: never, data?: Json) => Promise<void>
    : Emit;

/** How a run started: an app call, the `every` timer, or the `on` state. */
export type Trigger = "call" | "every" | "on";

/** An action as written: what `action()` takes, minus the types. */
export type ActionBody = {
  input?: StandardSchemaV1;
  every?: number;
  on?: State;
  run(conn: unknown, input: unknown): Promise<Json>;
};

/** What the runtime runs: the body plus its name and its connection's definition id (from the folders). */
export type ActionSpec = ActionBody & { id: string; connection: string };

const ACTION = Symbol.for("connectd.action");

/** A written action. `I`/`O` are its input and output, for the typed client. */
export type Action<I = unknown, O extends Json = Json> = {
  readonly [ACTION]: ActionBody;
  /** Types only. */
  readonly "~io"?: { input: I; output: O };
};

export type AnyAction = Action<any, any>;

export const actionOf = (a: AnyAction): ActionBody => a[ACTION];
export const isAction = (v: unknown): v is AnyAction => typeof v === "object" && v !== null && ACTION in v;

/** `void` (nothing returned) comes back as null. */
type Out<O> = O extends undefined | void ? null : O;

// Names end up in stored names (`actions.<name>.*`), URLs and the SDK's `actions` proxy, which
// never calls these (promises, JSON.stringify and String() probe them).
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** Why `name` can't name an action, or null. `connection` and `webhook` start other events' types (`connection.active`, `webhook.push`). */
export const badActionName = (name: string): string | null =>
  !NAME.test(name)
    ? "letters, digits, _ and - only"
    : name === "then" || name === "toJSON" || name === "status" || name === "connection" || name === "webhook" || name in Object.prototype
      ? "reserved"
      : null;
/** Why `name` can't name a connection's own event, or null. No dots, so it never meets `connection.*`, `webhook.*` or `<action>.completed`. */
export const badEventName = (name: string): string | null =>
  !NAME.test(name) ? "letters, digits, _ and - only" : name === "connection" || name === "webhook" || name in Object.prototype ? "reserved" : null;

/** An action the app calls with input, checked by the runtime before `run` (a 400 with the schema's issues otherwise). No triggers. */
export function action<S extends StandardSchemaV1, O extends Json | void>(spec: {
  input: S;
  run(conn: ActionCtx, input: OutputOf<S>): O | Promise<O>;
}): Action<InputOf<S>, Out<O>>;
/**
 * An action without input: the app calls it, and `every` / `on` run it on their own.
 * - `every`: every `ms` (at least 1000) while the connection is active, the first run `ms` after it becomes active.
 * - `on`: once each time the connection enters the state (`active`: the first login, and each re-auth
 *   after `reauth_required`; a login while already active isn't an entry). Connections already in
 *   it when the action is deployed count as entering it the first time they're seen.
 */
export function action<O extends Json | void>(spec: { every?: number; on?: State; run(conn: ActionCtx): O | Promise<O> }): Action<undefined, Out<O>>;
export function action(spec: { input?: StandardSchemaV1; every?: number; on?: State; run(conn: unknown, input?: unknown): unknown }): AnyAction {
  if (typeof spec?.run !== "function") throw new Error("action({ run }): run is missing");
  if (spec.input && (spec.every !== undefined || spec.on !== undefined)) throw new Error("action: an action with input takes no every or on");
  if (spec.every !== undefined && !(Number.isFinite(spec.every) && spec.every >= 1000)) throw new Error("action: every takes at least 1000 ms");
  const { run, ...rest } = spec;
  return { [ACTION]: { ...rest, run: async (conn, input) => ((await run(conn, input)) ?? null) as Json } };
}
