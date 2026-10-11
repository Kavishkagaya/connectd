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

## #17 defineConnection API — provisional

`packages/connections` (`@openconnect/connections`). Provisional until #19 ports GitHub, Slack and Google on it unchanged.

- **Shape:** `defineConnection({ id, auth, metadata?, rate? })` is an identity function for inference. `auth` is steps, not a flow type: `start(ctx, input)` returns `{ redirect(state), data }` or `{ credential }` (done inline), then `callback(ctx, params, data)`, `refresh(ctx, cred)` and `revoke(ctx, cred)`, both optional. `ctx` = `{ config, fetch, redirectUri, now }`.
- **Helpers build the steps:** `oauth2(spec)` (auth code + PKCE by default) and `apiKey(fields)`. A custom flow writes the steps itself; the kernel still owns state, handshake, refresh scheduling and the outbox.
- **`bind(def, d, instance, opts)`** runs a definition on one instance over `connection()`: `connect`, `callback`, `token`, `metadata`, `revoke`, `onTimer`. #22 wraps it in the DO and HTTP routing.
- **Typing:** `C` = connector config (from the auth helper, e.g. `oauth2<{ clientId; clientSecret }>`), `M` = metadata (inferred from `metadata`'s return, must be `Json`). No schema library; config is validated where it's entered (L3/L4).
- **Metadata:** `metadata(ctx, cred)` runs *before* activation, so it doubles as the credential check (a bad API key never activates). Stored in its own `meta` key, not inside the record's `cas`: it's derived, and re-auth rewrites it.
- **Quirks:** config when they're data (`scopes`, `scopeSeparator`, `params`, `clientAuth`, `pkce`, `invalidGrant` codes such as GitHub's `bad_refresh_token`), hooks when they're behaviour (`token` reshapes a response, `metadata`, `rate.observe`). Anything weirder is a custom step.
- **Rate:** declared as `rate: { connection?, app?, observe? }`. The proxy (#23) turns them into kernel scopes and decides which instance holds `app`.
- **Webhooks:** not in the definition yet; #25 adds a `webhooks` field (verify, route to a connection by external id via #26).
- **Versioning:** none. Definitions are code, and stored state is the kernel's own (record, credential, metadata), so deploying a new definition doesn't touch live connections. In-flight handshakes carry their own data and expire in 10 min. New scopes mean the app asks for re-auth (`connect` on the same instance). A definition must keep reading metadata it wrote before; add a version field when a definition first needs a migration.
- Open for #19: Slack user-token-only responses have no top-level `access_token`, so `tokenRequest` rejects them before the `token` hook runs. Device code needs a `{ prompt }` start result and a timer-driven poll step.
