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

Validation: build GitHub OAuth end-to-end on the in-memory driver (#14) and adjust this interface from what breaks.
