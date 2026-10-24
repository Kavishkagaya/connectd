import { type ActionSpec, type AnyAction, actionOf, apiFor, type SchemaIssue, type Store } from "@openconnect/connections";
import type { Json } from "@openconnect/kernel";
import { emit } from "./events.ts";
import { Fail, type Hooks, type Hosted } from "./host.ts";
import type { Extension } from "./runtime.ts";

/**
 * Actions (#54) on the connection's instance: `actions.<id>` methods (HTTP
 * `POST /connections/:def/:id/actions/:id`), the input checked against the action's Standard Schema
 * first; `.every(ms)` on a timer while the connection is active; `.on(state)` once per entry into
 * that state. Scheduled runs report as `action.completed` / `action.failed` events.
 */

/** Retries of a failed scheduled run, before it waits for the next one. */
const RETRY = { baseMs: 30_000, maxMs: 120_000, maxAttempts: 3 };
/** An `.every` run this far past due (plus its interval) had its timer lost: the next call re-arms it. */
const LOST_MS = 10 * 60_000;

const issues = (list: ReadonlyArray<SchemaIssue>): Json =>
  list.map((i) => ({
    message: i.message,
    ...(i.path ? { path: i.path.map((p) => String(typeof p === "object" ? p.key : p)) } : {}),
  }));

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Every action, grouped by its connection's definition id. Throws on a duplicate id for one connection. */
export function group(list: AnyAction[]): Map<string, ActionSpec[]> {
  const by = new Map<string, ActionSpec[]>();
  for (const a of list) {
    const s = actionOf(a);
    const mine = by.get(s.connection) ?? [];
    if (mine.some((m) => m.id === s.id)) throw new Error(`two actions named ${s.id} on ${s.connection}`);
    by.set(s.connection, [...mine, s]);
  }
  return by;
}

function hooks(h: Hosted, mine: ActionSpec[]): Hooks {
  // ponytail: one cell for every key of the connection's store (bounded by a stored value's size); a cell per key when stores grow.
  const cell = h.k.cell<Record<string, Json>>("actions.store");
  const store: Store = {
    get: async <T extends Json>(key: string) => ((await cell.read())?.value[key] ?? null) as T | null,
    set: async (key, value) => void (await cell.update((cur) => ({ ...cur, [key]: value }))),
    delete: async (key) => void (await cell.update((cur) => (cur && Object.hasOwn(cur, key) ? Object.fromEntries(Object.entries(cur).filter(([k]) => k !== key)) : null))),
  };
  const token = () => h.bound.token();
  const ctx = async () => ({
    config: h.bound.ctx.config,
    fetch: h.bound.ctx.fetch,
    now: () => h.k.now(),
    connection: { definition: h.def.id, id: h.id },
    identity: await h.bound.metadata(),
    token,
    store,
    ...(h.def.proxy ? { api: apiFor(h.bound.ctx, h.def.proxy, token) } : {}),
  });

  /** A scheduled run, if the connection is still in the state it's for. Reports either way; a throw is retried by the timer. */
  async function scheduled(a: ActionSpec, trigger: "every" | "on", attempt: number): Promise<boolean> {
    const s = await h.bound.conn.read();
    if (s?.state !== (trigger === "every" ? "active" : a.on)) return false;
    try {
      const output = await a.run(await ctx(), undefined);
      await emit(h, { action: a.id, trigger, output }, "action.completed");
    } catch (e) {
      console.error("action failed", h.instance, a.id, trigger, attempt, e);
      await emit(h, { action: a.id, trigger, error: message(e), attempt: attempt + 1 }, "action.failed");
      throw e;
    }
    return true;
  }

  const every = mine.flatMap((a) => {
    if (a.every === undefined) return [];
    const ms = a.every;
    const next = h.k.cell<{ at: number }>(`actions.${a.id}.next`);
    const arm = async () => {
      const at = h.k.now() + ms;
      await next.put({ at });
      await timer.set(at);
    };
    const timer = h.k.timer(`actions.${a.id}.every`, {
      async handle(_p, { attempt }) {
        if (!(await scheduled(a, "every", attempt))) return next.delete();
        await arm();
      },
      retry: RETRY,
      giveUp: arm,
    });
    return [{ ms, next, arm, timer }];
  });

  const on = mine.flatMap((a) => {
    if (a.on === undefined) return [];
    const state = a.on;
    const seen = h.k.cell<{ state: string | null }>(`actions.${a.id}.seen`);
    const timer = h.k.timer(`actions.${a.id}.on`, {
      handle: async (_p, { attempt }) => void (await scheduled(a, "on", attempt)),
      retry: RETRY,
    });
    return [{ state, seen, timer }];
  });

  const methods = Object.fromEntries(
    mine.map((a) => [
      `actions.${a.id}`,
      async (args: Json): Promise<Json> => {
        let input: unknown;
        if (a.input) {
          const r = await a.input["~standard"].validate(args);
          if (r.issues) throw new Fail("bad_request", 400, `invalid input for ${a.id}`, issues(r.issues));
          input = r.value;
        }
        // Not active: the lifecycle's 409 (NotActive), before any action code runs.
        await token();
        return a.run(await ctx(), input);
      },
    ]),
  );

  return {
    methods,
    // ponytail: state changes are seen after each call or timer, not from the record's outbox, so a
    // state entered and left within one call is missed; relay the outbox here if that ever matters.
    async after() {
      if (!every.length && !on.length) return;
      const state = (await h.bound.conn.read())?.state ?? null;
      for (const e of every) {
        const n = (await e.next.read())?.value;
        if (state === "active") {
          // First time active, or the timer was lost (no run for a whole interval and then some).
          if (!n || h.k.now() > n.at + e.ms + LOST_MS) await e.arm();
        } else if (n) {
          await e.next.delete();
          await e.timer.cancel();
        }
      }
      for (const o of on) {
        let entered = false;
        await o.seen.update((prev) => {
          entered = state === o.state && prev?.state !== state;
          return prev?.state === state ? null : { state };
        });
        if (entered) await o.timer.set(h.k.now());
      }
    },
  };
}

/** The actions extension; `runtime({ actions })` adds it. */
export function actions(list: AnyAction[]): Extension {
  const by = group(list);
  return { connection: (h) => hooks(h, by.get(h.def.id) ?? []) };
}
