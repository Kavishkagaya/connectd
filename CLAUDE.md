# openconnect

OAuth connection platform: open-source self-host path plus a low-cost managed service on Cloudflare. Full solution (SDK, CLI, events, webhooks), not just an HTTP API. Apache-2.0. The managed layer lives in a separate private repo (`openconnect-cloud`).

## Layers

```
 L4  DevX        SDK · connect UI · CLI · dashboard            (in progress)
 L3  Runtime     ConnectionDO · proxy · webhooks · events      (done)
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
  src/define.ts       defineConnection, Definition (incl. webhooks: verify/parse/register), hmacHex/safeEqual, bind (runs a definition on one instance)
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
  src/webhooks.ts     webhooks() extension: public /webhooks/:def[/:id], verify + parse per definition, app-level fan-out via the index, emit(); auto-register/renew/unregister per connection
  src/session.ts      sessions() extension (#29): browser session tokens, /session routes (CORS) + single-use tickets, /callback redirect or popup page, confirm step

packages/sdk/         server SDK (#28): fetch only, no Node APIs (tsconfig.web.json typechecks it without Bun/Node types)
  src/client.ts       openconnect({ url, apiKey }): connection(def, id) status/connect/token/revoke/session/call/fetch, connections.page/list, OpenConnectError
  src/events.ts       oc.events({ secret }): on(type, handler), handle(Request) → Response (verify, dedupe, dispatch)
  src/node.ts         toNode(handle): a (Request) => Response handler as Node/Express (req, res) (`/node` export)
  src/testing.ts      the real runtime on the memory driver + fake providers, for the SDK's tests

packages/connect/     browser package (#29), zero dependencies, DOM only (tsconfig.web.json; the root tsc skips it)
  src/connect.ts      headless: connect({ url, token, mode: popup | redirect, fields? }) → Result, resume() on the return URL, session(), claims()
  src/ui.ts           mount(el, opts): prebuilt button, or a form for API-key definitions; returns unmount
  src/fake.ts         fake window/DOM in front of the real runtime, for the tests
  e2e/chromium.ts     one real-Chromium check, run by hand (needs Playwright; not in `bun run test`)

packages/cli/         `openconnect` bin (#30, #31; Bun only); `@openconnect/cli` exports project.ts
  src/project.ts      the project shape: defineConfig, Project (incl. deploy: { name, url }), settings(), options() = runtime() input from config + env + index. Workers-safe: the deployed Worker imports it
  src/keys.ts         ENV names + generateKeys(), no imports; src/workdir.ts the self-gitignoring .openconnect/ dir
  src/env.ts          .env / .dev.vars parsing; dev keys generated once into .openconnect/dev.vars
  src/load.ts         findConfig, importConfig (Bun.build bundle + import; dev reloads and deploy's plan)
  src/worker.ts       the Worker entry template (Workers types, tsconfig.workers.json); src/config.d.ts types its config import
  src/generate.ts     deploy's files in .openconnect/deploy/: entry (template, imports resolved), wrangler.json, copied migrations. Node only (vitest config uses it)
  src/deploy.ts       `openconnect deploy`: wrangler secret list, d1 list/create, migrations apply --remote, deploy, secret bulk (stdin)
  test/               the generated Worker for test/fixture run in workerd from its own wrangler.json (vitest)
  src/dev.ts          `openconnect dev`: memory driver on a real clock behind Bun.serve, snapshot in .openconnect/state.json, config bundled with Bun.build and swapped in place on save
  src/tunnel.ts       cloudflared quick tunnel (spawned, URL parsed from its log)
  src/cli.ts, args.ts commands (dev, deploy, help) and a declared-flags parser; src/bin.ts the entry

examples/basic/       a user project (workspace): openconnect.config.ts with the providers and one local definition
```

Kernel subpath exports: `@openconnect/kernel`, `/memory`, `/do`, `/parity`. Runtime: `@openconnect/runtime`, `/cloudflare`, `/signature`. CLI: `@openconnect/cli` (`defineConfig`, project helpers), bin `openconnect`. SDK: `@openconnect/sdk`, `/node`. Browser: `@openconnect/connect`.

## Commands

- `bun run test`: bun tests under `src/` plus vitest (workerd) under `test/`
- `bun run typecheck`: root tsc (`packages/*/src`, `examples/*`), plus Workers-types passes for `drivers/do.ts`, `runtime/src/cloudflare.ts`, the CLI's Worker template + `project.ts`, and each `test/`, a web-only pass for the SDK, and DOM passes for `packages/connect`
- One kernel file: `cd packages/kernel && bun test src/primitives/rate.test.ts`
- Dev server on the example: `cd examples/basic && bun run dev` (flags: `--port`, `--config`, `--tunnel`, `--url`, `--reset`; `openconnect --help`)
- Deploy plan without Cloudflare: `cd examples/basic && bunx openconnect deploy --dry-run` (then `wrangler deploy --dry-run -c .openconnect/deploy/wrangler.json` bundles it offline)

## Patterns

- **Driver = infrastructure only, per instance**: `store` (get/put/cas/take/delete, optional TTL), named durable `timer`s, `call` to another instance, `now()`. Everything else is kernel code on top.
- **Concurrency:** handlers interleave at every await (like DOs); the memory driver doesn't serialize either, on purpose. Anything that races goes through `cas` (versioned, no ABA) or `take` (single consumer). Use read-decide-cas loops (`update` in connection.ts and rate.ts).
- **Program composition:** a `Program` is `(driver, instance) => { onCall, onTimer }`. Primitives expose handlers to route into: `connection().onTimer`, `handleRate` for the `RATE` method. Create primitives once per Program instance (single-flight is in memory).
- **Cross-instance:** a scope (app, workspace) is just another instance key reached with `d.call`. Args and results must be `Json`.
- **Durability:** state and its events change in one `cas` (connection record holds state + sealed credential + event outbox). Timers aren't atomic with `cas`; there's always an on-demand fallback.
- **Time:** always `d.now()`, never `Date.now()`, so the fake clock works. Memory `advance(ms)` jumps once; step it to drive retries. `memory(p, { clock: Date.now })` is the real-clock mode (dev): timers fire on their own, `advance` still skews; `dump()`/`snapshot` restore state.
- **Secrets:** AES-GCM with a key-version byte; values sealed under old keys are re-sealed on read.
- **Tests:** primitives are tested on the memory driver with `bun:test`. Drivers prove equivalence through `parity.ts` (memory under bun, DO under vitest in workerd). New driver behaviour goes into parity, not one driver's tests.
- **Style:** small, minimal code; no abstraction without a second use. Deliberate shortcuts carry a `// ponytail:` comment naming the ceiling and the upgrade path. Strict TS with `noUncheckedIndexedAccess`; `.ts` extensions in imports.

## Process

- Work is planned as GitHub issues: epics per layer (#1 is the roadmap), each split into deep dives.
- Every deep dive's outcome goes into `DECISIONS.md` (one entry per issue, newest last, marked decided/provisional).
- **All changes go through PRs**: branch off `main`, never commit to `main` directly. Reference the issues in the PR ("Closes #n").
