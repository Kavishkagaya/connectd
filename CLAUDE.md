# openconnect

OAuth connection platform: open-source self-host path plus a low-cost managed service on Cloudflare. Full solution (SDK, CLI, events, webhooks), not just an HTTP API. Apache-2.0. The managed layer lives in a separate private repo (`openconnect-cloud`).

## Layers

```
 L4  DevX        SDK · connect UI · CLI · dashboard            (done; managed parts in openconnect-cloud)
 L3  Runtime     ConnectionDO · proxy · webhooks · events      (done)
 L2  Connections defineConnection(), lifecycle, OAuth, providers   (in progress)
 L1  Kernel      cell · flight · mutex · timer · queue · ticket · limiter · seal (#53)   (done)
 L0  Drivers     Durable Objects · in-memory · server (deferred)           (done)
```

A layer only uses the one below it. The kernel never imports Cloudflare; the DO driver and `runtime/src/cloudflare.ts` are the only places `cloudflare:workers` appears.

## Layout

```
packages/kernel/
  src/index.ts        public API (re-exports only)
  src/driver.ts       L0 contract: Json, Driver, Handler, Program
  src/drivers/        memory.ts, do.ts, parity.ts (shared driver suite)
  src/kernel.ts        kernel(): the management layer of one instance (#53): name claims, seal/unseal, serve (the Handler)
  src/cell.ts         cell (read-decide-cas update + outbox, take) and `loop`, the one cas loop every tool uses
  src/sync.ts         flight / flights (single-flight), mutex (one at a time); in memory
  src/timer.ts, queue.ts, ticket.ts, limiter.ts   alarms with retry · ordered retried delivery · signed one-time passes · GCRA permits
  src/secrets.ts, schedule.ts                      pure helpers: AES-GCM with key versions, HMAC sign/verify · backoff
  src/testkit.ts      memory-driver harness for the kernel's tests (not exported); tests next to each file
  test/               DO driver tests in workerd (vitest); tools.ts + tools.test.ts run the kernel's tools on the DO driver

packages/connections/
  src/lifecycle.ts    one connection on the kernel: the `record` cell (state, sealed credential, Transition outbox), token/refresh (flight + timer), login ticket; State, Credential, NotActive
  src/oauth.ts        OAuth protocol atoms (PKCE, authorize URL, code exchange, refresh, device flow, DCR, revoke), OAuthError
  src/define.ts       defineConnection, Definition (incl. webhooks: verify/parse/register), hmacHex/safeEqual, bind (a definition on one instance's kernel)
  src/builder.ts      connection(id).config<C>().auth(f => …).api(…).limit().observe().identity().external().webhooks() (#54): compiles to a Definition, read with definitionOf
  src/action.ts       action(id, connection).input(schema) | .every(ms) / .on(state) .run(fn) (#54): standalone actions, Standard Schema types, ActionCtx (api, store, token)
  src/flows.ts        the flows `.auth()` hands its callback (#56): oauth2, oidc (discovery, id_token checked, claims as identity), clientCredentials, jwtBearer, device, apiKey, flow
  src/jwt.ts          RS256 signing (PKCS#8 and PKCS#1 keys), id_token verification (RS256, ES256)
  src/auth.ts         auth steps: oauth2 (oauth2Steps: the standard steps the builder's overrides call as `next`), apiKey
  src/testing.ts      harness + fakeOAuth for definition tests (`/testing` export)

packages/providers/   one connection(...) builder per provider (github, github-app, slack, google); tests against fakes

packages/runtime/
  src/host.ts         the Program every connection instance runs: one kernel per instance, registry lookup, bind, extensions' hooks (Hosted.k), methods, faults
  src/http.ts         the Worker's fetch: routes table by first path segment, API key, /connections, /callback
  src/runtime.ts      runtime({ definitions, settings, extensions }) and the Extension type
  src/actions.ts      actions on the connection's instance (added by runtime({ actions })): actions.<id> methods + /actions/:id route, input validation, .every timers while active, .on per state entry, action.completed/failed events
  src/proxy.ts        proxy() extension: /proxy/:def/:id/<path>, token + rate permits in one DO call
  src/events.ts       events extension: what an event is and how it's signed and POSTed, on the kernel's queue (relays the record's outbox); emit(); events.status/flush/redeliver
  src/signature.ts    Standard Webhooks sign/verify, no imports (`/signature` export, for the SDK)
  src/cloudflare.ts   DO class + Worker fetch (`/cloudflare` export); test/ runs it in workerd
  src/directory.ts    connection index extension: Index, memoryIndex, list route, findByExternal (D1 in cloudflare.ts, migrations/)
  src/webhooks.ts     webhooks() extension: public /webhooks/:def[/:id], verify + parse per definition, app-level fan-out via the index, emit(); auto-register/renew/unregister per connection, or explicit subscriptions (subscribe/list/unsubscribe) when the definition has a `subscription` schema; webhooks.status
  src/session.ts      sessions() extension (#29): browser session tokens, /session routes (CORS) + single-use tickets, /callback redirect or popup page, confirm step

packages/sdk/         server SDK (#28): fetch only, no Node APIs (tsconfig.web.json typechecks it without Bun/Node types)
  src/client.ts       openconnect<R = Registry>({ url, apiKey }): connection(def, id) status/connect/token/revoke/session/actions/webhooks/call/fetch, connections.page/list, OpenConnectError
  src/registry.ts     interface Registry (filled by the CLI's generated .openconnect/registry.d.ts), RegistryOf<typeof config, Exports<modules>>, the typed client's helper types
  src/events.ts       oc.events({ secret }): on(type, handler), handle(Request) → Response (verify, dedupe, dispatch)
  src/node.ts         toNode(handle): a (Request) => Response handler as Node/Express (req, res) (`/node` export)
  src/testing.ts      the real runtime on the memory driver + fake providers, for the SDK's tests

packages/connect/     browser package (#29), zero dependencies, DOM only (tsconfig.web.json; the root tsc skips it)
  src/connect.ts      headless: connect({ url, token, mode: popup | redirect, fields? }) → Result, resume() on the return URL, session(), claims()
  src/ui.ts           mount(el, opts): prebuilt button, or a form for API-key definitions; returns unmount
  src/fake.ts         fake window/DOM in front of the real runtime, for the tests
  e2e/chromium.ts     one real-Chromium check, run by hand (needs Playwright; not in `bun run test`)

packages/dashboard/   self-host dashboard (#32): dashboard() extension serving /dashboard from the runtime's Worker; runtime is a peer dep; the root tsc skips it
  src/index.ts        the extension: the page (strict CSP), assets, /dashboard/api/overview and /connections/:def/:id (API key)
  src/app.ts          the UI, zero dependencies, DOM only (tsconfig.web.json via main.ts); API key in sessionStorage, Bearer on same-origin fetch
  src/assets.ts       generated by `bun run build` (build.ts) from app.ts/main.ts/app.css and committed; a test fails when it's stale
  src/fake.ts         the real runtime + dashboard() on the memory driver and a fake DOM, for the tests and e2e
  e2e/chromium.ts     real-Chromium check, run by hand (needs Playwright; not in `bun run test`)

packages/cli/         `openconnect` bin (#30, #31; Bun only); `@openconnect/cli` exports project.ts; runtime/kernel/connections are peer deps
  src/project.ts      the project shape: defineConfig, Project (incl. deploy: { name, url }, dashboard: false to opt out), settings(), options() = runtime() input from config + env + index. Workers-safe: the deployed Worker imports it
  src/keys.ts         ENV names + generateKeys(), no imports; src/workdir.ts the self-gitignoring .openconnect/ dir
  src/env.ts          .env / .dev.vars parsing; dev keys generated once into .openconnect/dev.vars
  src/load.ts         findConfig, importConfig (Bun.build bundle + import; dev reloads and deploy's plan), loadProject (config + folder discovery)
  src/discover.ts     folder discovery (#54): dirs (default connections/, actions/), .openconnect/entry.ts (withModules) and registry.d.ts. Node APIs only
  src/worker.ts       the Worker entry template (Workers types, tsconfig.workers.json); src/config.d.ts types its config import
  src/generate.ts     deploy's files in .openconnect/deploy/: entry (template, imports resolved), wrangler.json, copied migrations. Node only (vitest config uses it)
  src/deploy.ts       `openconnect deploy`: wrangler secret list, d1 list/create, migrations apply --remote, deploy --secrets-file (0600 temp file, with the version)
  test/               the generated Worker for test/fixture run in workerd from its own wrangler.json (vitest)
  src/dev.ts          `openconnect dev`: memory driver on a real clock behind Bun.serve, snapshot in .openconnect/state.json, config bundled with Bun.build and swapped in place on save
  src/tunnel.ts       cloudflared quick tunnel (spawned, URL parsed from its log)
  src/cli.ts, args.ts commands (dev, deploy, types, help) and a declared-flags parser; src/bin.ts the entry

examples/basic/       a user project (workspace): openconnect.config.ts with the providers; connections/ (one local definition) and actions/ (one action), found by folder discovery
```

Kernel subpath exports: `@openconnect/kernel`, `/memory`, `/do`, `/parity`. Connection types (`State`, `Credential`, `NotActive`, OAuth) come from `@openconnect/connections`. Runtime: `@openconnect/runtime`, `/cloudflare`, `/signature`. CLI: `@openconnect/cli` (`defineConfig`, project helpers), bin `openconnect`. SDK: `@openconnect/sdk`, `/node`. Browser: `@openconnect/connect`. Dashboard: `@openconnect/dashboard`.

## Commands

- `bun run test`: bun tests under `src/` plus vitest (workerd) under `test/`
- `bun run typecheck`: root tsc (`packages/*/src`, `examples/*`), plus Workers-types passes for `drivers/do.ts`, `runtime/src/cloudflare.ts`, the CLI's Worker template + `project.ts`, and each `test/`, a web-only pass for the SDK, and DOM passes for `packages/connect` and `packages/dashboard`
- Dashboard UI changed: `cd packages/dashboard && bun run build` (rewrites src/assets.ts); real browser: `PLAYWRIGHT=/path/to/playwright/index.mjs bun packages/dashboard/e2e/chromium.ts`
- One kernel file: `cd packages/kernel && bun test src/limiter.test.ts`
- Dev server on the example: `cd examples/basic && bun run dev` (flags: `--port`, `--config`, `--tunnel`, `--url`, `--reset`; `openconnect --help`)
- Deploy plan without Cloudflare: `cd examples/basic && bunx openconnect deploy --dry-run` (then `wrangler deploy --dry-run -c .openconnect/deploy/wrangler.json` bundles it offline)

## Patterns

- **Driver = infrastructure only, per instance**: `store` (get/put/cas/take/delete, optional TTL), named durable `timer`s, `call` to another instance, `now()`. Everything else is kernel code on top.
- **Concurrency:** handlers interleave at every await (like DOs); the memory driver doesn't serialize either, on purpose. Anything that races goes through `cas` (versioned, no ABA) or `take` (single consumer), in the kernel: `cell.update` (read-decide-cas) and `cell.take`.
- **Kernel (#53):** `const k = kernel(driver, { instance, keys, stateKey })` once per Program call (the host does it, after settings load); every tool declared once as a typed handle (stored names: letters, digits, `_ . -`), `k.serve(methods)` as the Handler. Mechanism only: nothing about connections, tokens or providers goes in it. Extensions get the instance's kernel as `Hosted.k` and declare their own cells, timers and queues (names `<extension>.<name>`).
- **Program composition:** a `Program` is `(driver, instance) => { onCall, onTimer }`. `k.serve` routes timers to the handler declared under their name and `kernel.rate` to the limiter; instances without a kernel (app-wide limiters) answer `RATE` with `handleRate`.
- **Cross-instance:** a scope (app, workspace) is just another instance key reached with `d.call`. Args and results must be `Json`.
- **Durability:** a change and its messages land in one `cas` (the cell's outbox: the record holds state + sealed credential + Transitions); `queue.relay` moves them on exactly once. Timers aren't atomic with `cas`; there's always an on-demand fallback.
- **Time:** always `d.now()`, never `Date.now()`, so the fake clock works. Memory `advance(ms)` jumps once; step it to drive retries. `memory(p, { clock: Date.now })` is the real-clock mode (dev): timers fire on their own, `advance` still skews; `dump()`/`snapshot` restore state.
- **Secrets:** AES-GCM with a key-version byte; values sealed under old keys are re-sealed on read.
- **Tests:** the kernel's tools and the lifecycle are tested on the memory driver with `bun:test`. Drivers prove equivalence through `parity.ts` (memory under bun, DO under vitest in workerd). New driver behaviour goes into parity, not one driver's tests.
- **Style:** small, minimal code; no abstraction without a second use. Deliberate shortcuts carry a `// ponytail:` comment naming the ceiling and the upgrade path. Strict TS with `noUncheckedIndexedAccess`; `.ts` extensions in imports.

## Process

- Work is planned as GitHub issues: epics per layer (#1 is the roadmap), each split into deep dives.
- Every deep dive's outcome goes into `DECISIONS.md` (one entry per issue, newest last, marked decided/provisional).
- **All changes go through PRs**: branch off `main`, never commit to `main` directly. Reference the issues in the PR ("Closes #n").
