import { type AnyAction, type AnyConnection, definitionOf } from "@kavishkagaya/connectd-connections";
import { actions, group } from "./actions.ts";
import { type AnyDefinition, type Hooks, type Hosted, host, type Settings } from "./host.ts";
import { http, type Route, routes } from "./http.ts";

/** A runtime feature (proxy, events, webhooks, index): HTTP routes, per-connection hooks, or both. */
export type Extension = {
  routes?: Record<string, Route>;
  connection?(h: Hosted): Hooks;
  /** Methods for the extension's own routes only (RPC): `POST /connections/.../:method` refuses them, like `kernel.*`. */
  internal?: string[];
  /** Keeps the connection index current (`directory`): routes then get `platform.db.connections` as `api.index`. */
  index?: boolean;
};

export type RuntimeOptions = {
  /** Bundled definitions by id (self-host): `connection(...)` builders or plain definitions. Managed loads user code differently (#34). */
  definitions: Record<string, AnyDefinition | AnyConnection>;
  settings: () => Promise<Settings>;
  /** What the app does with connections (#54): `action({ ... })`s by connection id, then by name (a connection folder's `actions.ts`). */
  actions?: Record<string, Record<string, AnyAction>>;
  extensions?: Extension[];
};

/**
 * The L3 runtime: `program` runs in each connection's atom, `fetch(req, platform)` at the front door
 * (a Worker, the dev server). Both come from one set of options so they agree on definitions and
 * settings; neither knows which platform it runs on.
 */
export function runtime(o: RuntimeOptions) {
  let loaded: Promise<Settings> | undefined;
  const settings = () => (loaded ??= o.settings());
  // The key is the id (a folder's name).
  const definitions = Object.fromEntries(Object.entries(o.definitions).map(([id, d]) => [id, { ...definitionOf(d), id }]));
  const by = o.actions && Object.keys(o.actions).length ? group(o.actions, definitions) : null;
  const acts = by ? actions(by) : null;
  const exts = [...(acts ? [acts] : []), ...(o.extensions ?? [])];
  const index = exts.some((e) => e.index);
  return {
    program: host({ definitions, settings, connection: exts.flatMap((e) => (e.connection ? [e.connection] : [])) }),
    // Built-in routes win on a name clash, like built-in methods.
    fetch: http({
      routes: Object.assign({}, ...exts.map((e) => e.routes), routes),
      definitions,
      actions: by ? Object.fromEntries(by) : {},
      settings,
      internal: new Set(exts.flatMap((e) => e.internal ?? [])),
      index,
    }),
  };
}

export type Runtime = ReturnType<typeof runtime>;
