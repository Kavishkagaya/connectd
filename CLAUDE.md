# openconnect

OAuth connection platform: open-source self-host path plus a low-cost managed service on Cloudflare. Full solution (SDK, CLI, events, webhooks), not just an HTTP API. Apache-2.0. The managed layer lives in a separate private repo (`openconnect-cloud`).

## Layers

```
 L4  DevX        SDK · CLI · dashboard                         (not started)
 L3  Runtime     ConnectionDO · proxy · webhooks · events      (in progress)
 L2  Connections defineConnection(), providers                 (in progress)
 L1  Kernel      connection · tokens · rate · secrets · schedule · oauth   (done)
 L0  Drivers     Durable Objects · in-memory · server (deferred)           (done)
```

A layer only uses the one below it. The kernel never imports Cloudflare; the DO driver and `runtime/src/cloudflare.ts` are the only places `cloudflare:workers` appears.

## Layout

```
packages/kernel/
  src/index.ts        public API (re-exports only)
  src/driver.ts       L0 contract: Json, Driver, Handler, Program
  src/drivers/        memory.ts, do.ts, parity.ts (shared driver suite)
  src/primitives/     connection, oauth, rate, schedule, secrets; tests next to each
  test/               DO driver tests in workerd (vitest)

packages/connections/
  src/define.ts       defineConnection, Definition, bind (runs a definition on one instance)
  src/auth.ts         auth step builders: oauth2, apiKey
  src/testing.ts      harness + fakeOAuth for definition tests (`/testing` export)

packages/providers/   one defineConnection per provider (github, slack, google); tests against fakes

packages/runtime/
  src/host.ts         the Program every connection instance runs: registry lookup, bind, methods, faults
  src/http.ts         the Worker's fetch: routes table by first path segment, API key, /connections, /callback
  src/runtime.ts      runtime({ definitions, settings, extensions }) and the Extension type
  src/proxy.ts        proxy() extension: /proxy/:def/:id/<path>, token + rate permits in one DO call
  src/events.ts       events extension: signed, ordered, at-least-once delivery to the user's server; emit()
  src/signature.ts    Standard Webhooks sign/verify, no imports (`/signature` export, for the SDK)
  src/cloudflare.ts   DO class + Worker fetch (`/cloudflare` export); test/ runs it in workerd
  src/directory.ts    connection index extension: Index, memoryIndex, list route, findByExternal (D1 in cloudflare.ts, migrations/)
```

Kernel subpath exports: `@openconnect/kernel`, `/memory`, `/do`, `/parity`. Runtime: `@openconnect/runtime`, `/cloudflare`, `/signature`.

## Commands

- `bun run test`: bun tests under `src/` plus vitest (workerd) under `test/`
- `bun run typecheck`: root tsc, plus Workers-types passes for `drivers/do.ts`, `runtime/src/cloudflare.ts` and each `test/`
- One kernel file: `cd packages/kernel && bun test src/primitives/rate.test.ts`

## Patterns

- **Driver = infrastructure only, per instance**: `store` (get/put/cas/take/delete, optional TTL), named durable `timer`s, `call` to another instance, `now()`. Everything else is kernel code on top.
- **Concurrency:** handlers interleave at every await (like DOs); the memory driver doesn't serialize either, on purpose. Anything that races goes through `cas` (versioned, no ABA) or `take` (single consumer). Use read-decide-cas loops (`update` in connection.ts and rate.ts).
- **Program composition:** a `Program` is `(driver, instance) => { onCall, onTimer }`. Primitives expose handlers to route into: `connection().onTimer`, `handleRate` for the `RATE` method. Create primitives once per Program instance (single-flight is in memory).
- **Cross-instance:** a scope (app, workspace) is just another instance key reached with `d.call`. Args and results must be `Json`.
- **Durability:** state and its events change in one `cas` (connection record holds state + sealed credential + event outbox). Timers aren't atomic with `cas`; there's always an on-demand fallback.
- **Time:** always `d.now()`, never `Date.now()`, so the fake clock works. Memory `advance(ms)` jumps once; step it to drive retries.
- **Secrets:** AES-GCM with a key-version byte; values sealed under old keys are re-sealed on read.
- **Tests:** primitives are tested on the memory driver with `bun:test`. Drivers prove equivalence through `parity.ts` (memory under bun, DO under vitest in workerd). New driver behaviour goes into parity, not one driver's tests.
- **Style:** small, minimal code; no abstraction without a second use. Deliberate shortcuts carry a `// ponytail:` comment naming the ceiling and the upgrade path. Strict TS with `noUncheckedIndexedAccess`; `.ts` extensions in imports.

## Process

- Work is planned as GitHub issues: epics per layer (#1 is the roadmap), each split into deep dives.
- Every deep dive's outcome goes into `DECISIONS.md` (one entry per issue, newest last, marked decided/provisional).
- **All changes go through PRs**: branch off `main`, never commit to `main` directly. Reference the issues in the PR ("Closes #n").
