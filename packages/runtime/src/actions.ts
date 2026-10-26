import { type ActionSpec, type AnyAction, actionOf, apiFor, badActionName, NotActive, type SchemaIssue, type State, type Store } from "@kavishkagaya/connectd-connections";
import type { Json } from "@kavishkagaya/connectd-kernel";
import { emit } from "./events.ts";
import { Fail, type Hooks, type Hosted } from "./host.ts";
import type { Extension } from "./runtime.ts";

/**
 * Actions (#54) on the connection's instance: `actions.<id>` methods (HTTP
 * `POST /connections/:def/:id/actions/:id`), the input checked against the action's Standard Schema
 * first; `.every(ms)` on a timer while the connection is active; `.on(state)` once per entry into
 * that state. Scheduled runs report as `<action>.completed` / `<action>.failed` events; `conn.emit`
 * sends the connection's own (`.events({ ... })`), checked against their schemas.
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

/** The actions by connection, checked: each on a known connection, each name usable. */
export function group(by: Record<string, Record<string, AnyAction>>, definitions: Record<string, unknown>): Map<string, ActionSpec[]> {
  const out = new Map<string, ActionSpec[]>();
  for (const [connection, list] of Object.entries(by)) {
    if (!Object.hasOwn(definitions, connection)) throw new Error(`actions for ${connection}: no connection ${connection} in definitions`);
    out.set(
      connection,
      Object.entries(list).map(([id, a]) => {
        const bad = badActionName(id);
        if (bad) throw new Error(`action ${connection}/${id}: the name is ${bad}`);
        return { ...actionOf(a), id, connection };
      }),
    );
  }
  return out;
}

function hooks(h: Hosted, mine: ActionSpec[]): Hooks {
  // ponytail: one cell for every key of the connection's store (bounded by a stored value's size); a cell per key when stores grow.
  const cell = h.k.cell<Record<string, Json>>("actions.store");
  const store: Store = {
    get: async <T extends Json>(key: string) => {
      const v = (await cell.read())?.value;
      return (v && Object.hasOwn(v, key) ? v[key] : null) as T | null;
    },
    set: async (key, value) => void (await cell.update((cur) => ({ ...cur, [key]: value }))),
    delete: async (key) => void (await cell.update((cur) => (cur && Object.hasOwn(cur, key) ? Object.fromEntries(Object.entries(cur).filter(([k]) => k !== key)) : null))),
  };
  const token = () => h.bound.token();
  /** A run's context. Its emits wait in `sent` until the run succeeds (`flush`). */
  const ctx = async (sent: { name: string; data: Json }[]) => {
    const c = {
      config: h.bound.ctx.config,
      fetch: h.bound.ctx.fetch,
      now: () => h.k.now(),
      connection: { definition: h.def.id, id: h.id },
      identity: await h.bound.metadata(),
      token,
      store,
      emit: async (name: string, data?: Json) => {
        const schema = h.def.events && Object.hasOwn(h.def.events, name) ? h.def.events[name] : undefined;
        if (!schema) throw new Error(`${h.def.id} has no event ${name}: declare it with .events({ ${name}: schema })`);
        const r = await schema["~standard"].validate(data);
        if (r.issues) throw new Error(`event ${name}: ${r.issues.map((i) => i.message).join("; ")}`);
        sent.push({ name, data: (r.value ?? null) as Json });
      },
    };
    // A getter that throws, not a missing field: `conn.api.get` would otherwise fail as "undefined is not an object".
    const proxy = h.def.proxy;
    return Object.defineProperty(c, "api", {
      enumerable: !!proxy,
      get: () => {
        if (!proxy) throw new Error(`${h.def.id} has no .api(): use conn.token() and conn.fetch`);
        return apiFor(h.bound.ctx, proxy, token);
      },
    });
  };

  const flush = async (sent: { name: string; data: Json }[]) => {
    for (const e of sent) await emit(h, e.data, e.name);
  };

  /** The state and the record's version, without decrypting the credential. */
  const record = async (): Promise<{ state: State; v: number } | null> => {
    const r = await h.bound.conn.record.read();
    return r ? { state: r.value.state, v: r.v } : null;
  };

  /**
   * A scheduled run, if the connection is still in the state it's for. Reports either way; a throw
   * is retried by the timer. A connection that stopped being active mid-run (revoked) is no failure.
   */
  async function scheduled(a: ActionSpec, trigger: "every" | "on", attempt: number): Promise<boolean> {
    if ((await record())?.state !== (trigger === "every" ? "active" : a.on)) return false;
    let output: Json;
    const sent: { name: string; data: Json }[] = [];
    try {
      output = await a.run(await ctx(sent), undefined);
    } catch (e) {
      if (e instanceof NotActive) return false;
      console.error("action failed", h.instance, a.id, trigger, attempt, e);
      await emit(h, { action: a.id, trigger, error: message(e), attempt: attempt + 1 }, `${a.id}.failed`);
      throw e;
    }
    // Outside the try: a failed emit must not run the action again.
    await flush(sent);
    await emit(h, { action: a.id, trigger, output }, `${a.id}.completed`);
    return true;
  }

  const every = mine.flatMap((a) => {
    if (a.every === undefined) return [];
    const ms = a.every;
    const next = h.k.cell<{ at: number }>(`actions.${a.id}.next`);
    /** The next run, if the connection is (still) active. */
    const arm = async () => {
      if ((await record())?.state !== "active") return next.delete();
      const at = h.k.now() + ms;
      await next.put({ at });
      await timer.set(at);
    };
    const timer = h.k.timer(`actions.${a.id}.every`, {
      async handle(_p, { attempt }) {
        await scheduled(a, "every", attempt);
        await arm();
      },
      retry: RETRY,
      giveUp: arm,
    });
    return [{ id: a.id, ms, next, arm, timer }];
  });

  const on = mine.flatMap((a) => {
    if (a.on === undefined) return [];
    const state = a.on;
    /** The state last seen and the record version it was seen at: an older read never overwrites a newer one. */
    const seen = h.k.cell<{ state: State; v: number }>(`actions.${a.id}.seen`);
    const timer = h.k.timer(`actions.${a.id}.on`, {
      handle: async (_p, { attempt }) => void (await scheduled(a, "on", attempt)),
      retry: RETRY,
    });
    return [{ state, seen, timer }];
  });

  const methods: Record<string, (args: Json) => Promise<Json>> = Object.fromEntries(
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
        const sent: { name: string; data: Json }[] = [];
        const out = await a.run(await ctx(sent), input);
        await flush(sent);
        return out;
      },
    ]),
  );

  /** Each action's trigger and next scheduled run, for the dashboard. */
  methods["actions.status"] = async () => {
    const next = new Map(await Promise.all(every.map(async (e) => [e.id, (await e.next.read())?.value.at ?? null] as const)));
    return mine.map((a) => ({ id: a.id, every: a.every ?? null, on: a.on ?? null, next: next.get(a.id) ?? null }));
  };

  // Record version last handled, this isolate; undefined: check once after a restart (covers a lost timer).
  let checked: number | undefined;

  return {
    methods,
    // ponytail: state entries are seen after each call or timer, not from the record's outbox, so a
    // state entered and left within one call is missed; relay the outbox here if that ever matters.
    async after() {
      if (!every.length && !on.length) return;
      // One small read, no decrypt, on calls that changed nothing (most: tokens, proxied requests).
      const r = await record();
      if (!r || r.v === checked) return;
      checked = r.v;
      // Another call may have moved the state since `r`: act only while `r` is still the latest.
      const current = async () => (await record())?.v === r.v;
      for (const e of every) {
        const n = (await e.next.read())?.value;
        if (r.state === "active") {
          // First time active, or the timer was lost (no run for a whole interval and then some).
          if ((!n || h.k.now() > n.at + e.ms + LOST_MS) && (await current())) await e.arm();
        } else if (n && (await current())) {
          await e.next.delete();
          await e.timer.cancel();
        }
      }
      for (const o of on) {
        let entered = false;
        await o.seen.update((prev) => {
          entered = false;
          if (prev && prev.v >= r.v) return null;
          entered = r.state === o.state && prev?.state !== r.state;
          return { state: r.state, v: r.v };
        });
        if (entered) await o.timer.set(h.k.now());
      }
    },
  };
}

/** The actions extension, from `group`'s result; `runtime({ actions })` adds it. */
export function actions(by: Map<string, ActionSpec[]>): Extension {
  return { connection: (h) => hooks(h, by.get(h.def.id) ?? []) };
}
