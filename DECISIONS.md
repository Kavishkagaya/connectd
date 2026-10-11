# Decisions

One entry per deep dive. Newest last.

## #3 Repo layout — decided

Two repos.
- `openconnect` (OSS): everything a user needs. Kernel, drivers, runtime, SDK, CLI, providers, self-host dashboard. One monorepo; providers stay a package.
- `openconnect-cloud` (private): the managed layer. Multi-tenancy, user-code isolation, billing/metering, managed-only dashboard features.

## #4 License — decided

`openconnect` is Apache-2.0 (permissive, patent grant, best for adoption). `openconnect-cloud` is proprietary. Future versions may move to FSL if hosted competitors become a real threat.

## #6 Driver interface — provisional

The driver provides infrastructure guarantees only, per instance. Everything an auth flow needs (handshake, credential record, single-flight, rate, outbox, config) is kernel code built on top.

Driver: `packages/kernel/src/index.ts`
- `store`: `get` / `put` (optional TTL) / `cas` (versioned compare-and-swap) / `take` (atomic read+delete) / `delete`
- `timer`: durable named timers, `set` replaces, `cancel`; fired via `Handler.onTimer`
- `call(instance, method, args)`: cross-instance call; args/results are serialized
- `now()`: the clock (fake in tests)

Kernel → driver: `Handler { onCall, onTimer }`. Every event reaches an instance through it.

- **Async API.** Postgres can't be sync; semantic ops keep the DO fast anyway.
- **No full serialization guarantee.** Each store op is atomic, but handlers may interleave at awaits, as in Durable Objects. Races go through `cas`/`take`. The in-memory driver doesn't serialize either, so tests see the same races.
- **Cross-instance is hidden by the driver.** An app-scope rate instance is just another instance key.

Defaults for open points (revisit when building the first flow):
- OAuth callback routing: `state` = signed `connId.random`, no global lookup.
- Lifecycle state lives inside the credential record, so one `cas` covers both.
- Connection index by external id (#26) stays out of the driver until L3.

Validation: in-memory driver + DO driver must pass one shared parity suite (#13, #14).

## #13 Durable Object driver — decided

`@openconnect/kernel/do` (`packages/kernel/src/do.ts`): `durableObject(program, { binding })` returns a DO class. No separate package; a subpath export keeps `cloudflare:workers` out of anything that doesn't import it. Split only when a driver brings heavy deps (e.g. `pg`).

- One DO per instance key, created with `idFromName`; the key comes from `ctx.id.name`.
- SQLite storage: `kv(key, v, value, expires_at)`, `timers(name, at, payload)`, `seq(n)`. Every store op is synchronous SQL with no await inside, so it is atomic against other events.
- Versions come from one per-DO counter, so they never repeat after a delete (no ABA on `cas`).
- Expiry: filtered on read; expired rows swept on each write so abandoned handshakes don't pile up.
- Timers multiplexed on the single alarm, always set to the earliest timer. On alarm, fire due timers earliest first.
- `call` = RPC to `env[binding]` by `idFromName(instance)`, into the DO's `onCall`.
- No v1 migration (starting over, no production data). D1 as a global index waits for L3 (#26).

## #14 In-memory driver + parity — decided

- Fake clock: `now` is a plain number; `advance(ms)` moves it, then fires due timers.
- Timer semantics (both drivers): removed before firing (at-most-once; retries are the kernel's job, #11). `now()` during `onTimer` is the time it fired, not the scheduled time. A throwing timer is logged and doesn't block later ones. Timers set while firing run in the same advance if due.
- `@openconnect/kernel/parity`: one runner-agnostic suite (`parity(name, world, { test, expect })`) driven through a `probe` program. Memory runs it under `bun test`, the DO driver under `@cloudflare/vitest-plugin` in workerd, with a fake clock far in the future so real alarms never fire on their own.
