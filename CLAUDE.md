# connectd

OAuth connection platform: open-source self-host path plus a low-cost managed service on Cloudflare. Full solution (SDK, CLI, events, webhooks), not just an HTTP API. Apache-2.0. The managed layer lives in a separate private repo (`openconnect-cloud`).

## Layers

```
 L4  DevX        SDK · connect UI · CLI · dashboard            (done; managed parts in openconnect-cloud)
 L3  Runtime     ConnectionDO · proxy · webhooks · events      (done)
 L2  Connections defineConnection(), lifecycle, OAuth, providers   (in progress)
 L1  Kernel      cell · flight · mutex · timer · queue · ticket · limiter · seal (#53)   (done)
 L0  Platform    Platform (env · fetch · log · defer · atoms · db · limits) + Atom (store · timer) on: Durable Objects + D1 · memory · server (deferred)
```

A layer only uses the one below it. The kernel never imports Cloudflare; the Cloudflare platform (`kernel/src/drivers/do.ts`) and the Cloudflare target's Worker template are the only places `cloudflare:workers` appears.

## Layout

```
packages/kernel/
  src/index.ts        public API (re-exports only)
  src/platform.ts     L0 contract: Platform (per deployment: version, now, env, fetch, log, defer, atoms.call/destroy, db: Management, limits) + Atom (per connection: name, now, store, timer); Handler, Program = (atom, platform) => Handler; Unavailable, LimitExceeded, LIMITS (every platform's); the connection index's row types and cursors
  src/drivers/        the platforms: memory.ts (tests + dev; `unreachable` fault injection, memoryDb()), do.ts (Durable Objects + D1: durableObject(), cloudflarePlatform()), parity.ts (two shared suites: `parity` for an atom, `platformParity` for the deployment)
  migrations/         the D1 schema of the Cloudflare platform's management db (copied by `connectd deploy`)
  src/kernel.ts        kernel(atom, platform, { keys, stateKey }): the management layer of one atom (#53): name claims, seal/unseal, serve (the Handler)
  src/cell.ts         cell (read-decide-cas update + outbox, take) and `loop`, the one cas loop every tool uses
  src/sync.ts         flight / flights (single-flight), mutex (one at a time); in memory
  src/timer.ts, queue.ts, ticket.ts, limiter.ts   alarms with retry · ordered retried delivery · signed one-time passes · GCRA permits
  src/secrets.ts, schedule.ts                      pure helpers: AES-GCM with key versions, HMAC sign/verify · backoff
  src/testkit.ts      memory-platform harness for the kernel's tests (not exported); tests next to each file
  test/               both parity suites on Durable Objects + D1 in workerd (vitest); tools.ts + tools.test.ts run the kernel's tools there

packages/connections/
  src/lifecycle.ts    one connection on the kernel: the `record` cell (state, sealed credential, Transition outbox), token/refresh (flight + timer), login ticket; State, Credential, NotActive
  src/oauth.ts        OAuth protocol atoms (PKCE, authorize URL, code exchange, refresh, device flow, DCR, revoke), OAuthError
  src/define.ts       defineConnection, Definition (incl. webhooks: verify/parse/register), hmacHex/safeEqual, bind (a definition on one instance's kernel)
  src/builder.ts      connection(id?).config<C>().auth(f => …).api(…).limit().observe().identity().external().webhooks() (#54): compiles to a Definition, read with definitionOf; `.config((env) => C)` (env("NAME"), env.optional; envConfig in define.ts); withId (a folder's name as the id)
  src/action.ts       action({ input?, every?, on?, run(conn, input) }) (#54) and actions({ name: action }) (#83): a connection folder's actions.ts maps names to actions (badActions checks keys and values), Standard Schema types, ActionCtx (api, store, token)
  src/flows.ts        the flows `.auth()` hands its callback (#56): oauth2, oidc (discovery, id_token checked, claims as identity), clientCredentials, jwtBearer, device, apiKey, flow
  src/jwt.ts          RS256 signing (PKCS#8 and PKCS#1 keys), id_token verification (RS256, ES256)
  src/auth.ts         auth steps: oauth2 (oauth2Steps: the standard steps the builder's overrides call as `next`), apiKey
  src/testing.ts      harness + fakeOAuth for definition tests (`/testing` export)

packages/providers/   private (not published): the catalog's source. One connection(...) builder per provider (github, github-app, slack, google), each reading its env names (`.config((env) => ...)`), importing only @kavishkagaya/connectd/connections (what an app has); tests against fakes; `bun run registry` writes registry/. Apps never import it: `connectd add` copies a provider in
  src/registry.ts     `bun run registry`: writes registry/ (the catalog `connectd add` copies from) from the sources; a test fails when it's stale

registry/             <provider>.json + index.json, generated and committed; the CLI fetches it at its version's tag

packages/runtime/
  src/host.ts         the Program every connection's atom runs: one kernel per atom, registry lookup, bind, extensions' hooks (Hosted.k, Hosted.platform), methods, faults
  src/http.ts         the front door's fetch(req, platform): routes table by first path segment, API key, /connections, /callback
  src/runtime.ts      runtime({ definitions, settings, extensions }) and the Extension type
  src/actions.ts      actions on the connection's instance (added by runtime({ actions })): actions.<id> methods + /actions/:id route, actions.status, input validation, .every timers while active, .on per state entry, <action>.completed/failed events, conn.emit for the connection's own .events()
  src/proxy.ts        proxy() extension: /proxy/:def/:id/<path>, token + rate permits in one DO call
  src/events.ts       events extension: what an event is and how it's signed and POSTed, on the kernel's queue (relays the record's outbox); emit(); events.status/flush/redeliver
  src/signature.ts    Standard Webhooks sign/verify, no imports (`/signature` export, for the SDK)
  src/cloudflare.ts   the runtime on the Cloudflare platform: DO class + Worker fetch (`/cloudflare` export); test/ runs it in workerd
  src/directory.ts    connection index extension: keeps each connection's row in platform.db.connections, list route (api.index)
  src/webhooks.ts     webhooks() extension: public /webhooks/:def[/:id], verify + parse per definition, app-level fan-out via the index, emit(); auto-register/renew/unregister per connection, or explicit subscriptions (subscribe/list/unsubscribe) when the definition has a `subscription` schema; webhooks.status
  src/session.ts      sessions() extension (#29): browser session tokens, /session routes (CORS) + single-use tickets, /callback redirect or popup page, confirm step; GET /connect, the hosted connect page (`link()`)

packages/sdk/         server SDK (#28): fetch only, no Node APIs (tsconfig.web.json typechecks it without Bun/Node types)
  src/client.ts       connectd<R = Registry>({ url?, apiKey?, user?, listeners? }) (CONNECTD_* env defaults, read on first use): connection(def, id) status/connect/token/revoke/session/link/actions/webhooks/call/fetch, connections.page/list, ConnectdError
  src/registry.ts     interface Registry (filled by the CLI's generated .connectd/registry.d.ts), RegistryOf<typeof config, Exports<modules>>, the typed client's helper types, EventsOf (the events the app gets, typed per connection)
  src/events.ts       oc.events({ secret }): on(type, handler), handle(Request) → Response (verify, dedupe, dispatch)
  src/listen.ts       listen(id).on(type, handler): a folder's events.ts (app side), one connection's events
  src/routes.ts       oc.routes { GET, POST } (#54, app side): connect/:def (server-started redirect session), return (page + confirm), events (to listeners)
  src/node.ts         toNode(handle): a (Request) => Response handler as Node/Express (req, res) (`/node` export)
  src/testing.ts      the real runtime on the memory platform + fake providers, for the SDK's tests

packages/connect/     browser package (#29), zero dependencies, DOM only (tsconfig.web.json; the root tsc skips it)
  src/connect.ts      headless: connect({ url, token, mode: popup | redirect, fields? }) → Result, resume() on the return URL, session(), claims()
  src/ui.ts           mount(el, opts): prebuilt button, or a form for API-key definitions; returns unmount
  src/fake.ts         fake window/DOM in front of the real runtime, for the tests
  e2e/chromium.ts     one real-Chromium check, run by hand (needs Playwright; not in `bun run test`)

packages/dashboard/   self-host dashboard (#32): dashboard() extension serving /dashboard from the runtime's Worker; runtime is a peer dep; the root tsc skips it
  src/index.ts        the extension: the page (strict CSP), assets, /dashboard/api/overview, /connections/:def/:id (actions.status, webhooks.list) and /failures (API key)
  src/app.ts          the UI, zero dependencies, DOM only (tsconfig.web.json via main.ts); API key in sessionStorage, Bearer on same-origin fetch; actions panel + Run form (from JSON Schema), subscriptions, #/actions
  src/assets.ts       generated by `bun run build` (build.ts) from app.ts/main.ts/app.css and committed; a test fails when it's stale
  src/fake.ts         the real runtime + dashboard() on the memory platform and a fake DOM, for the tests and e2e
  e2e/chromium.ts     real-Chromium check, run by hand (needs Playwright; not in `bun run test`)

packages/cli/         `connectd` bin (#30, #31; Bun in the workspace, Node or Bun once packed). `@kavishkagaya/connectd`, the one package an app installs: exports project.ts, and src/sdk.ts, sdk-node.ts, connections.ts, connections-testing.ts, runtime*.ts, kernel*.ts re-export the private packages (`/sdk`, `/sdk/node`, `/connections`, `/connections/testing`, `/runtime`, `/runtime/cloudflare`, `/runtime/signature`, `/kernel`, `/kernel/memory`, `/kernel/do`); `bun run pack` carries those packages inside it
  src/project.ts      the project shape: defineConfig, Project (incl. deploy: { name, url }, dashboard: false to opt out), resolve() (connections' env config, `envNames`, `missing`), workerEnv(), settings(), options() = runtime() input from config + env + index. Workers-safe: the deployed Worker imports it
  src/keys.ts         ENV names + generateKeys(), no imports; src/workdir.ts the self-gitignoring .connectd/ dir
  src/env.ts          dotenv parsing; dev's env (.env < process env; .dev.vars refused)
  src/init.ts         `connectd init`: dev's keys + CONNECTD_URL + APP_URL into .env (keys from an old .connectd/dev.vars moved), .gitignore, oc.config.ts, <src>/lib/oc.ts, the Next.js route; never overwrites
  src/load.ts         findConfig, importConfig (esbuild bundle to .mjs + import; dev reloads and deploy's plan), loadProject (config + connection folders); CONFIG_FILES: oc.config.ts
  src/discover.ts     connection folders (#54): dir (default src/oc or oc), <id>/connection.ts + <id>/actions.ts (export default actions({ name: action() }), #83; an actions/ folder without it is refused as the 0.2 layout) + <id>/events.ts (never in the Worker), .connectd/entry.ts (withFolders), registry.d.ts and app.ts (the listeners, for the app). Node APIs only
  src/target.ts       deploy targets (#54): Target ({ adapter, options }: data, bundled with the config), DeployContext, Adapter
  src/deploy.ts       `connectd deploy`, what every target shares: the environment (--env <name>, default production: .env.<name> or --env-file, the shell in CI; only names read are sent), dev values refused, the target's adapter loaded from the project, the app's env lines
  src/dev.ts          `connectd dev`: memory platform on a real clock behind node:http, keys from .env (init's; never made here), port from CONNECTD_URL, snapshot in .connectd/state.json, config bundled with esbuild and swapped in place on save (watcher skips build output, hidden dirs, generated types)
  src/tunnel.ts       cloudflared quick tunnel (spawned, URL parsed from its log)
  src/add.ts          `connectd add <provider>` (copy from registry/ into <dir>/<id>/, events.ts, .env names) `connectd add --custom <id> --template <flow>` (the same folder from src/templates.ts: oauth2, oidc, api-key, client-credentials, jwt-bearer, device) and `connectd diff <id>` (unified diff against the catalog)
  src/cli.ts, args.ts commands (init, dev, deploy, types, keys, add, diff, help) and a declared-flags parser; src/bin.ts the entry

packages/cloudflare/  the Cloudflare deploy target (#54): `cloudflare({ name, url })` in oc.config.ts; the adapter deploys through wrangler
  src/index.ts        cloudflare(): a Target, data only (Workers-safe: the config is bundled into the Worker)
  src/adapter.ts      deploy(ctx) (`/adapter` export, Node): per environment its own Worker/D1 (`<name>-<env>`, cloudflare({ environments })) and state file; wrangler secret list, d1 list/create, migrations apply --remote, deploy --secrets-file (0600 temp file, with the version)
  src/generate.ts     deploy's files in .connectd/deploy/: entry (template, imports resolved), wrangler.json, copied migrations. Node only (vitest config uses it)
  src/worker.ts       the Worker entry template (Workers types, tsconfig.workers.json); src/config.d.ts types its config import
  test/               the generated Worker for test/fixture run in workerd from its own wrangler.json (vitest)

examples/nextjs/      a Next.js app (excluded from the root tsc; `next build` checks it): github (OAuth app), oc.routes, APP_URL in .env; `connectd dev` and `next dev` run side by side

scripts/pack.ts       `bun run pack`: the two published packages built to JavaScript (tsc in the Node, Workers and DOM type environments), each carrying its private workspace dependencies (imports rewritten to relative paths), npm-packed into .pack/

examples/basic/       a user project (workspace): oc.config.ts (dir, connector config, events, sessions); src/oc/<id>/ per connection (three providers copied in by `connectd add`, one custom, github/actions.ts)
```

Published: `@kavishkagaya/connectd` and `@kavishkagaya/connectd-cloudflare` only; kernel, connections, runtime, sdk, dashboard and connect are private workspace packages (`connect` is unpublished for now). Code outside the core (generated files, the Cloudflare target, docs) imports the core's subpaths: `@kavishkagaya/connectd` (`defineConfig`, project helpers, target types), `/sdk`, `/sdk/node`, `/connections`, `/connections/testing`, `/runtime`, `/runtime/cloudflare`, `/runtime/signature`, `/kernel`, `/kernel/memory`, `/kernel/do`, `/keys`, `/workdir`, bin `connectd`. Inside the workspace, packages import each other by their own names (`@kavishkagaya/connectd-kernel`, `-connections`, `-runtime`, `-sdk`, `-dashboard`); Connection types (`State`, `Credential`, `NotActive`, OAuth) come from connections. Cloudflare target: `@kavishkagaya/connectd-cloudflare`, `/adapter`.

## Commands

- `bun run test`: bun tests under `src/` plus vitest (workerd) under `test/`
- `bun run typecheck`: root tsc (`packages/*/src`, `examples/*`), plus Workers-types passes for `drivers/do.ts`, `runtime/src/cloudflare.ts`, the Cloudflare Worker template + the CLI's `project.ts`, and each `test/`, a web-only pass for the SDK, and DOM passes for `packages/connect` and `packages/dashboard`
- Packages as npm tarballs that run on Node: `bun run pack` (into .pack/: `@kavishkagaya/connectd` and `-cloudflare`; install them in a scratch project to try `npx connectd` without Bun)
- Provider changed: `cd packages/providers && bun run registry` (rewrites registry/)
- Dashboard UI changed: `cd packages/dashboard && bun run build` (rewrites src/assets.ts); real browser: `PLAYWRIGHT=/path/to/playwright/index.mjs bun packages/dashboard/e2e/chromium.ts`
- One kernel file: `cd packages/kernel && bun test src/limiter.test.ts`
- Dev server on the example: `cd examples/basic && bunx connectd init` once (keys into .env), then `bun run dev` (flags: `--port`, `--config`, `--tunnel`, `--url`, `--reset`; `connectd --help`)
- Deploy plan without Cloudflare: `cd examples/basic && bunx connectd deploy --dry-run` (then `wrangler deploy --dry-run -c .connectd/deploy/wrangler.json` bundles it offline)

## Patterns

- **Platform + Atom = infrastructure only** (`platform.ts`). The Atom is one connection's state, single owner: `store` (get/put/cas/take/delete, optional TTL), named durable `timer`s, `now()`. The Platform is the deployment: `env`, outbound `fetch`, `log`, `defer`, `atoms.call`/`destroy` by name, `db` (connectd's management data: fixed named operations, never generic, never user-facing), `limits`, `version`. Everything else is kernel code on top. Store and timers survive restarts and redeploys; memory doesn't.
- **Above L0, everything goes through the platform:** outbound HTTP is `platform.fetch` (definitions' `ctx.fetch`, the proxy, events), logs are `platform.log(level, event, fields)` (connections use `k.log`), configuration is `platform.env` read name by name (`options(config, platform.env)`). No global `fetch`, `console` or env record above L0; tests hand the memory platform a fake `fetch`.
- **Concurrency:** handlers interleave at every await (like DOs); the memory platform doesn't serialize either, on purpose. Anything that races goes through `cas` (versioned, no ABA) or `take` (single consumer), in the kernel: `cell.update` (read-decide-cas) and `cell.take`.
- **Kernel (#53):** `const k = kernel(atom, platform, { keys, stateKey })` once per Program call (the host does it, after settings load); every tool declared once as a typed handle (stored names: letters, digits, `_ . -`), `k.serve(methods)` as the Handler. Mechanism only: nothing about connections, tokens or providers goes in it. Extensions get the instance's kernel as `Hosted.k` and declare their own cells, timers and queues (names `<extension>.<name>`).
- **Program composition:** a `Program` is `(atom, platform) => { onCall, onTimer }`. `k.serve` routes timers to the handler declared under their name and `kernel.rate` to the limiter; instances without a kernel (app-wide limiters) answer `RATE` with `handleRate`.
- **Cross-atom:** a scope (app, workspace) is just another atom name reached with `platform.atoms.call`. Args and results must be `Json`; an atom that can't be reached throws `Unavailable`.
- **Durability:** a change and its messages land in one `cas` (the cell's outbox: the record holds state + sealed credential + Transitions); `queue.relay` moves them on exactly once. Timers aren't atomic with `cas`; there's always an on-demand fallback.
- **Time:** always `d.now()`, never `Date.now()`, so the fake clock works. Memory `advance(ms)` jumps once; step it to drive retries. `memory(p, { clock: Date.now })` is the real-clock mode (dev): timers fire on their own, `advance` still skews; `dump()`/`snapshot` restore state.
- **Secrets:** AES-GCM with a key-version byte; values sealed under old keys are re-sealed on read.
- **Tests:** the kernel's tools and the lifecycle are tested on the memory platform with `bun:test`. Platforms prove equivalence through `parity.ts`: `parity` (an atom) and `platformParity` (atoms, destroy, limits, env, defer, every `db` operation), memory under bun, Durable Objects + D1 under vitest in workerd. New platform behaviour goes into parity, not one platform's tests.
- **Style:** small, minimal code; no abstraction without a second use. Deliberate shortcuts carry a `// ponytail:` comment naming the ceiling and the upgrade path. Strict TS with `noUncheckedIndexedAccess`; `.ts` extensions in imports.

## Process

- Work is planned as GitHub issues: epics per layer (#1 is the roadmap), each split into deep dives.
- Every deep dive's outcome goes into `DECISIONS.md` (one entry per issue, newest last, marked decided/provisional).
- **All changes go through PRs**: branch off `main`, never commit to `main` directly. Reference the issues in the PR ("Closes #n").
