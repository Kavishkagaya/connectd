import { type AnyAction, type AnyConnection, actionOf, definitionOf } from "@openconnect/connections";
import { actions } from "./actions.ts";
import type { Index } from "./directory.ts";
import { type AnyDefinition, type Hooks, type Hosted, host, type Settings } from "./host.ts";
import { http, type Route, routes } from "./http.ts";

/** A runtime feature (proxy, events, webhooks, index): HTTP routes, per-connection hooks, or both. */
export type Extension = {
  routes?: Record<string, Route>;
  connection?(h: Hosted): Hooks;
  /** Methods for the extension's own routes only (RPC): `POST /connections/.../:method` refuses them, like `kernel.*`. */
  internal?: string[];
  /** The connection index (`directory`); routes get it as `api.index`. The first one provided wins. */
  index?: Index;
};

export type RuntimeOptions = {
  /** Bundled definitions by id (self-host): `connection(...)` builders or plain definitions. Managed loads user code differently (#34). */
  definitions: Record<string, AnyDefinition | AnyConnection>;
  settings: () => Promise<Settings>;
  /** What the app does with connections (#54): `action(id, connection)` builders, each on a connection in `definitions`. */
  actions?: AnyAction[];
  extensions?: Extension[];
  /** The Worker's clock (`api.now`); connection instances use their driver's. Default `Date.now`. */
  now?: () => number;
};

/**
 * The L3 runtime: `program` runs in each connection instance (the ConnectionDO), `fetch` in the
 * Worker in front. Both come from one set of options so they agree on definitions and settings.
 */
export function runtime(o: RuntimeOptions) {
  let loaded: Promise<Settings> | undefined;
  const settings = () => (loaded ??= o.settings());
  const definitions = Object.fromEntries(Object.entries(o.definitions).map(([id, d]) => [id, definitionOf(d)]));
  for (const a of o.actions ?? []) {
    const s = actionOf(a);
    if (!Object.hasOwn(definitions, s.connection)) throw new Error(`action ${s.id}: no connection ${s.connection} in definitions`);
  }
  const exts = [...(o.actions?.length ? [actions(o.actions)] : []), ...(o.extensions ?? [])];
  const index = exts.find((e) => e.index)?.index;
  return {
    program: host({ definitions, settings, connection: exts.flatMap((e) => (e.connection ? [e.connection] : [])) }),
    // Built-in routes win on a name clash, like built-in methods.
    fetch: http({
      routes: Object.assign({}, ...exts.map((e) => e.routes), routes),
      definitions,
      settings,
      internal: new Set(exts.flatMap((e) => e.internal ?? [])),
      ...(index ? { index } : {}),
      ...(o.now ? { now: o.now } : {}),
    }),
  };
}

export type Runtime = ReturnType<typeof runtime>;
