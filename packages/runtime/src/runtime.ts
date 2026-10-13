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
  /** Bundled definitions by id (self-host). Managed loads user code differently (#34). */
  definitions: Record<string, AnyDefinition>;
  settings: () => Promise<Settings>;
  extensions?: Extension[];
};

/**
 * The L3 runtime: `program` runs in each connection instance (the ConnectionDO), `fetch` in the
 * Worker in front. Both come from one set of options so they agree on definitions and settings.
 */
export function runtime(o: RuntimeOptions) {
  let loaded: Promise<Settings> | undefined;
  const settings = () => (loaded ??= o.settings());
  const exts = o.extensions ?? [];
  const index = exts.find((e) => e.index)?.index;
  return {
    program: host({ definitions: o.definitions, settings, connection: exts.flatMap((e) => (e.connection ? [e.connection] : [])) }),
    // Built-in routes win on a name clash, like built-in methods.
    fetch: http({
      routes: Object.assign({}, ...exts.map((e) => e.routes), routes),
      definitions: o.definitions,
      settings,
      internal: new Set(exts.flatMap((e) => e.internal ?? [])),
      ...(index ? { index } : {}),
    }),
  };
}

export type Runtime = ReturnType<typeof runtime>;
