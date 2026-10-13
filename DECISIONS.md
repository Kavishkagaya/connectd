# Decisions

One entry per deep dive. Newest last.

## #3 Repo layout — decided

Two repos.
- `openconnect` (OSS): everything a user needs. Kernel, drivers, runtime, SDK, CLI, providers, self-host dashboard. One monorepo; providers stay a package.
- `openconnect-cloud` (private): the managed layer. Multi-tenancy, user-code isolation, billing/metering, managed-only dashboard features.

## #4 License — decided

`openconnect` is Apache-2.0 (permissive, patent grant, best for adoption). `openconnect-cloud` is proprietary. Future versions may move to FSL if hosted competitors become a real threat.

## #6 Driver interface — decided

The driver provides infrastructure guarantees only, per instance. Everything an auth flow needs (handshake, credential record, single-flight, rate, outbox, config) is kernel code built on top.

Driver: `packages/kernel/src/driver.ts`
- `store`: `get` / `put` (optional TTL) / `cas` (versioned compare-and-swap) / `take` (atomic read+delete) / `delete`
- `timer`: durable named timers, `set` replaces, `cancel`; fired via `Handler.onTimer`
- `call(instance, method, args)`: cross-instance call; args/results are serialized
- `now()`: the clock (fake in tests)

Kernel → driver: `Handler { onCall, onTimer }`. Every event reaches an instance through it.

- **Async API.** Postgres can't be sync; semantic ops keep the DO fast anyway.
- **No full serialization guarantee.** Each store op is atomic, but handlers may interleave at awaits, as in Durable Objects. Races go through `cas`/`take`. The in-memory driver doesn't serialize either, so tests see the same races.
- **Cross-instance is hidden by the driver.** An app-scope rate instance is just another instance key.

Defaults for open points (held up through L1, #7–#11):
- OAuth callback routing: `state` = signed `connId.random`, no global lookup.
- Lifecycle state lives inside the credential record, so one `cas` covers both.
- Connection index by external id (#26) stays out of the driver until L3.

Validation: in-memory driver + DO driver must pass one shared parity suite (#13, #14).

## #13 Durable Object driver — decided

`@openconnect/kernel/do` (`packages/kernel/src/drivers/do.ts`): `durableObject(program, { binding })` returns a DO class. No separate package; a subpath export keeps `cloudflare:workers` out of anything that doesn't import it. Split only when a driver brings heavy deps (e.g. `pg`).

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

## #7 Connection lifecycle — decided

`packages/kernel/src/primitives/connection.ts`. One `record` key holds state, sealed credential and an event outbox, so one `cas` covers all three.

- States: `pending`, `active`, `reauth_required`, `revoked`. "Refreshing" is in-memory single-flight, not a state. "Expired" is derived from `expiresAt`. Transient errors don't change state.
- Legal: none → pending | active. pending → pending | active | revoked. active → active | reauth_required | revoked. reauth_required → reauth_required | active | revoked. revoked is terminal (reconnect = new connection). `active` requires a credential.
- Triggers: `activate` (callback / re-auth), `revoke`, refresh `invalid_grant`, refresh retries exhausted, expired with no refresh token.
- Events: `{ seq, at, from, to, reason? }` on every state change, appended to an outbox inside the record (same `cas`). L3 reads `events.pending()` and calls `events.ack(seq)` (#24). Capped at 100; oldest dropped.
- Re-auth: the connection moves to `reauth_required` and keeps its id; a new handshake ends in `activate` on the same instance.
- Handshake: flow data under a TTL key; `state` = HMAC-signed `[instance, id]`, so `routeState` finds the instance with no lookup. `take` is single-use.

## #8 Token primitives — decided

- Credential is a tagged union: `oauth2` (`accessToken`, `refreshToken?`, `expiresAt?`, `raw` = full token response, which keeps extras like `instance_url` / `id_token`) or `static` (`fields`: API keys, basic auth, anything that doesn't refresh).
- Refresh is injected (`opts.refresh`); L2 wires it to `refreshGrant`. Single-flight per instance.
- Scheduling: timer `kernel.refresh` at `expiresAt - lead`, lead = min(5 min, half the lifetime), plus up to 10% jitter. `token()` also refreshes on demand inside 60s of expiry, and hands out the old token if a refresh fails transiently while it is still valid.
- Failures: `invalid_grant` → `reauth_required`. Anything else retries with backoff (30s base, 8 attempts) → `reauth_required` (`refresh_failed`).
- Rotation: the old refresh token is kept if the response has none. A lost `cas` after a refresh retries the write unless the credential was replaced meanwhile, so a rotated token is never dropped.
- Timer and `cas` aren't atomic; a crash between them leaves no timer, and `token()` covers it.

## #9 Rate primitives — decided

`packages/kernel/src/primitives/rate.ts`.

- GCRA: one number per key (TAT), exact, cheap. Burst = `count`, then one per `periodMs / count`. Keys expire once TAT passes.
- Scope = `{ instance, key, limit }`. Any scope (connection, app, workspace, custom) is just an instance key; remote ones go through `d.call(instance, RATE)`, so a Program routes `RATE` to `handleRate`. How a definition declares scopes is L2 (#17).
- Multi-scope `acquire` is in order and all or nothing: on a deny, earlier grants are refunded. `refund` for requests that never reached the provider.
- Provider headers via `observe`: `Retry-After` and `remaining: 0` + reset block until then; `remaining > 0` caps the burst. Only ever tightens.
- Reject with `retryAfterMs`, no queue: waiting is the caller's choice (L3).
- Deferred: cross-tenant fairness on a shared scope; sharding a scope hotter than one instance (~1k rps).

## #10 Secrets primitive — decided

`packages/kernel/src/primitives/secrets.ts`. v1 AES-GCM with a key-version byte, HMAC sign/verify, `importKeys` from env strings.

- `secrets(d, keys)`: sealed values in the instance store. Connector client secrets live in a per-app instance (replaces TeamDO); which instance is L3.
- Rotation: add the new version, make it current. Reads re-seal anything under an older key (both `secrets` and the connection credential). Retire the old key once nothing sealed under it remains.

## #11 Schedule primitive — decided

`packages/kernel/src/primitives/schedule.ts`.

- Multiplexing is the driver's job (done in #13 / #14).
- `retry(d, name, attempt, data, backoff)`: exponential with equal jitter (never 0), the attempt count rides in the payload so it survives restarts, false once attempts run out.
- No cron: recurring work re-arms its own timer from `onTimer`.

## #18 OAuth atoms — decided

`packages/kernel/src/primitives/oauth.ts`. Lives in the kernel (L1 per the roadmap), not in L2.

- Auth code + PKCE (`pkce`, `authorizeUrl`, `exchangeCode`), `refreshGrant`, `clientCredentials`, device code (`deviceAuthorize`, `devicePoll`; pending / slow_down come back as `OAuthError` codes), DCR (`register`), revocation (`revoke`).
- Client auth `post` (default) or `basic`; `clientSecret` optional for public clients. `fetchFn` passed in.
- Errors: `OAuthError(code, status, body)`, including 200-with-error (GitHub).
- do-connect's `src/oauth.ts` wasn't available locally; per-provider quirks come with #19 / #20.

## #17 defineConnection API — decided

`packages/connections` (`@openconnect/connections`). Held up through #19 with the small changes listed there.

- **Shape:** `defineConnection({ id, auth, metadata?, rate? })` is an identity function for inference. `auth` is steps, not a flow type: `start(ctx, input)` returns `{ redirect(state), data }` or `{ credential }` (done inline), then `callback(ctx, params, data)`, `refresh(ctx, cred)` and `revoke(ctx, cred)`, both optional. `ctx` = `{ config, fetch, redirectUri, now }`.
- **Helpers build the steps:** `oauth2(spec)` (auth code + PKCE by default) and `apiKey(fields)`. A custom flow writes the steps itself; the kernel still owns state, handshake, refresh scheduling and the outbox.
- **`bind(def, d, instance, opts)`** runs a definition on one instance over `connection()`: `connect`, `callback`, `token`, `metadata`, `revoke`, `onTimer`. #22 wraps it in the DO and HTTP routing.
- **Typing:** `C` = connector config (from the auth helper, e.g. `oauth2<{ clientId; clientSecret }>`), `M` = metadata (inferred from `metadata`'s return, must be `Json`). No schema library; config is validated where it's entered (L3/L4).
- **Metadata:** `metadata(ctx, cred)` runs *before* activation, so it doubles as the credential check (a bad API key never activates). Stored in its own `meta` key, not inside the record's `cas`: it's derived, and re-auth rewrites it.
- **Quirks:** config when they're data (`scopes`, `scopeSeparator`, `params`, `clientAuth`, `pkce`, `invalidGrant` codes such as GitHub's `bad_refresh_token`), hooks when they're behaviour (`token` reshapes a response, `metadata`, `rate.observe`). Anything weirder is a custom step.
- **Rate:** declared as `rate: { connection?, app?, observe? }`. The proxy (#23) turns them into kernel scopes and decides which instance holds `app`.
- **Webhooks:** not in the definition yet; #25 adds a `webhooks` field (verify, route to a connection by external id via #26).
- **Versioning:** none. Definitions are code, and stored state is the kernel's own (record, credential, metadata), so deploying a new definition doesn't touch live connections. In-flight handshakes carry their own data and expire in 10 min. New scopes mean the app asks for re-auth (`connect` on the same instance). A definition must keep reading metadata it wrote before; add a version field when a definition first needs a migration.
- Device code needs a `{ prompt }` start result and a timer-driven poll step; added when the first provider in #20 needs it.

## #19 First providers: GitHub, Slack, Google — decided

`packages/providers` (`@openconnect/providers`), each a `defineConnection` with tests against fakes shaped like the real responses (`fakeOAuth` + `harness` in `@openconnect/connections/testing`).

The structure (steps, helpers, metadata, rate) held. What the port changed:
- **Scopes are per-app config:** `OAuth2Config.scopes` overrides the definition's defaults, and `input.scope` overrides both. `params` can be a function of config (Slack's `user_scope`).
- **`access_token` check moved from `tokenRequest` to `credentialFrom`** (kernel), so the `token` hook reshapes first: Slack with user scopes only nests the token under `authed_user`.
- **`rate.observe(res, now)`** + `rateHeaders`: `Retry-After` (seconds or date) for all three, plus GitHub's `x-ratelimit-*`.
- **Overriding one step is a spread:** `{ ...oauth2(spec), revoke }`. GitHub needs it (`DELETE /applications/{id}/grant`, not RFC 7009), and so does Slack (`auth.revoke`).

Per provider:
- **GitHub:** OAuth Apps and GitHub Apps in one definition (expiry is optional). PKCE S256. `bad_refresh_token` → `invalid_grant`. The REST API needs a `User-Agent`. Metadata `{ id, login }` from `/user`.
- **Slack:** comma scopes, bot token as the credential, user token lifted up when only user scopes are asked for. Rotation is handled when the app turns it on. PKCE off until confirmed. Metadata `{ teamId, ... }` from the token response; `teamId` is what webhooks route by (#25, #26). Rate is one Tier-3 budget for now; per-method tiers wait for the proxy (#23).
- **Google:** `access_type=offline` + `prompt=consent` so every authorization returns a refresh token; refresh tokens don't rotate (the kernel keeps the old one). Metadata `{ sub, email }` read from the `id_token` without a signature check (it comes straight from the token endpoint over TLS).

## #22 Generic ConnectionDO — decided

`packages/runtime` (`@openconnect/runtime`). `runtime({ definitions, settings, extensions })` returns `program` (runs in every connection instance) and `fetch` (the Worker in front). `@openconnect/runtime/cloudflare`: `cloudflare(rt, { binding })` gives the DO class and the Worker's fetch; nothing else touches Cloudflare, so everything else is tested on the memory driver.

- **Loading definitions:** self-host bundles them; the registry is a plain `{ [id]: definition }` passed in. The instance key is `conn:<def>:<id>` (`instanceOf`), so a DO knows which definition to run with no lookup. The program builds `bind` lazily on the first event, after `settings()` resolves (keys, state key, API key, redirect URI, connector config per definition id). Settings load once per isolate: Workers can't do crypto at global scope. Managed loads user code differently (#34).
- **Isolation:** definition code only gets `ctx` (config, fetch, redirectUri, now). It never sees the driver, the keys or other connections, and the kernel owns every write. That's as far as it goes in one isolate: a definition can still hang or burn CPU (workerd's limits apply). Real isolation is the managed sandbox (#34).
- **When user code throws:** every user hook runs before the kernel's `cas` (`start` before the handshake opens, `metadata` before `activate`, `refresh` before `update`), so a throw leaves the record as it was. Provider `revoke` failing is logged; the connection is revoked locally anyway. The one thing a failed callback uses up is its handshake, which is single-use anyway; the app calls `connect` again.
- **Errors as data:** error classes don't survive a DO RPC, so connection methods reply `{ ok } | { error: Fault }` with `{ code, status, message, state?, reason? }`. `Fail(code, status, msg)` for runtime and extension errors, `InputError` (new in L2 for missing apiKey fields and unknown `state`) → 400, `NotActive` (now also from `connect` on a revoked connection) / `IllegalTransition` → 409, `OAuthError` → 400 (502 when the provider 5xx'd), anything else → 500 `error` and logged. `RATE` stays raw: it's kernel-to-kernel.
- **HTTP:** the routes table is keyed by first path segment. `GET /connections/:def/:id` = status + metadata; `POST /connections/:def/:id/:method` = any connection method (`connect`, `token`, `revoke`, extensions'), JSON body = args, `kernel.*` blocked. `GET /callback` is public and routes by signed `state`. Everything else needs `Authorization: Bearer <apiKey>`. Callback answers JSON for now; a redirect back to the app comes with the SDK (L4).
- **Timers:** `kernel.refresh` goes to `bind`, then to each extension's `onTimer` until one claims it.
- Non-connection instances (app-scope rate keys on the same DO class) only answer `RATE` for now.

Extension points for #23–#26: each feature is one file in `packages/runtime/src/` exporting an `Extension` (`{ routes?, connection? }` in `runtime.ts`), passed in `extensions: [...]`. Built-in routes and methods win on a name clash.
- `routes: { <segment>: { public?, fetch(req, api, path) } }` for Worker-level endpoints (proxy `/proxy/...`, webhooks `/webhooks/...`). `api.call(instance, method, args)` reaches a connection and returns a `Reply`; `reply(r)` turns it into a Response. Throw `Fail` for an HTTP error.
- `connection(hosted) => { methods?, onTimer?, after? }` per connection instance. `hosted` = `{ d, instance, def, id, bound, settings }`; `bound.conn` is the kernel connection (`events.pending()` / `ack(seq)` for #24). `methods` are reachable by RPC and over HTTP; `onTimer` claims timers named `<extension>.<name>`; `after(cause)` runs after every method and timer, failed ones too, so events delivery (#24) and the index (#26) can follow state changes.

## #26 Connection index & querying — decided

`packages/runtime/src/directory.ts`: an `Index` (`upsert`, `list`), `memoryIndex()` for tests and dev, and `directory(index)`, the extension that keeps it current. `d1Index(binding)` in `/cloudflare` is the D1 one; schema in `packages/runtime/migrations/0001_index.sql`.

**D1 schema.** `connections (def, id, state, reason, external JSON, created_at, updated_at, version)`, primary key `(def, id)`, plus `connection_external (def, key, value, id)`, one row per external id. Nothing secret is copied: the credential stays sealed in the DO.
- **External ids:** a definition declares `external(metadata) => Record<string, string>` (new optional field in `defineConnection`): Slack `{ teamId }`, GitHub `{ id }`, Google `{ sub }`. They're indexed `(def, key, value)`, not unique: one Slack team can have several connections (one per app user). Webhooks (#25) route with `findByExternal(index, def, key, value)` (or `api.index` from a route).
- **List:** `GET /connections?def=&state=&q=&external=key:value&cursor=&limit=` (API key), `{ connections: Row[], cursor }`. Ordered by `(def, id)`; keyset cursor (opaque, base64url of the last key), `limit` 1–200, default 50. `q` is a case-insensitive substring of the id or any external value; it scans (FTS5 when lists get big). `/connections` with no segment lists; `/connections/:def/:id` is unchanged. The built-in route handles both, and lists only if an extension provided an index (`Extension.index`, handed to routes as `api.index`); without one it's a 404 as before.
- One deployment = one app (#22), so there is no app/tenant column yet; managed adds one with multi-app (#34).

**Consistency.** The ConnectionDO is the source of truth; the index is a copy, eventually consistent.
- **Write path:** the extension's `after()` reads the record and the metadata, and upserts the row after every method and timer, failed ones too. `version` = the DO's store version (record or metadata, whichever is newer; the driver's per-instance counter orders both), and the upsert only replaces a row with `version <= excluded.version` (in D1: `ON CONFLICT ... WHERE`, external ids moved in the same batch). So writes that arrive out of order (interleaved `after`s, retries) never roll a row back. Calls that changed nothing (`token`, `status`) skip the write.
- **Failures:** an upsert that throws is logged by the host and doesn't fail the call. The row catches up on the next call or timer on that connection (the skip only remembers successful writes). `POST /connections/:def/:id/index.sync` forces a re-copy of one connection: the repair path for a lost or restored database.
- ponytail: no full rebuild. A DO namespace can't be enumerated, so rebuilding from nothing needs a list of instances; that's the index itself, or a log of creations (#24's events). Add a bulk `sync` over a list of ids if a restore ever needs it.
- ponytail: the upsert is awaited inside the call, so D1 latency lands on the caller; move it to `waitUntil` if it shows.
- Doesn't read or ack the event outbox; that's #24's.
- No delete: connections are never deleted (revoked is terminal).

**Deploy (#31):** a D1 database bound as the name passed to `d1Index` (`INDEX` in the tests), with `migrations/0001_index.sql` applied (`wrangler d1 migrations apply`, `migrations_dir = "packages/runtime/migrations"`).
