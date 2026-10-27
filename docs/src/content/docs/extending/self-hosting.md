---
title: Self-hosting without the CLI
description: Use runtime() directly. Your own Worker, your own server, your own settings, or a new platform.
sidebar:
  order: 3
---

The CLI is a convenience. Underneath, everything is one function, `runtime()`, plus a platform. Use it directly when you want full control: your own Worker with other routes, a custom settings source, or a platform the CLI doesn't target.

```mermaid
flowchart LR
  DEFS["definitions<br/>(connection builders)"] --> RT["runtime({ definitions, settings, actions, extensions })"]
  SET["settings()"] --> RT
  EXT["extensions<br/>proxy · events · webhooks · sessions · directory · dashboard"] --> RT
  RT --> PG["program<br/>→ a platform's atoms (DO, memory, yours)"]
  RT --> FE["fetch(req, platform)<br/>→ your HTTP server"]
```

## On Cloudflare, by hand

```ts title="worker.ts"
import { env } from "cloudflare:workers";
import { importHmacKey, importKeys } from "@kavishkagaya/connectd/kernel";
import { directory, events, proxy, runtime, sessions, webhooks } from "@kavishkagaya/connectd/runtime";
import { cloudflare } from "@kavishkagaya/connectd/runtime/cloudflare";
import github from "./oc/github/connection.ts";

const rt = runtime({
  definitions: { github },
  // Loaded once per isolate, lazily: Workers can't do crypto at global scope.
  settings: async () => ({
    keys: await importKeys({ 1: env.CONNECTD_KEY_V1 }, 1),
    stateKey: await importHmacKey(env.CONNECTD_STATE_KEY),
    apiKey: env.CONNECTD_API_KEY,
    redirectUri: "https://connect.example.com/callback",
    config: { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } },
    events: { url: "https://app.example.com/api/connectd/events", secret: env.CONNECTD_EVENTS_SECRET },
    webhooks: { url: "https://connect.example.com/webhooks", key: await importHmacKey(env.CONNECTD_WEBHOOKS_KEY) },
    sessions: { key: await importHmacKey(env.CONNECTD_SESSIONS_KEY), origins: ["https://app.example.com"] },
  }),
  extensions: [proxy(), events(), webhooks(), sessions(), directory()],
});

// The platform: atoms in the CONNECTION Durable Objects, the management db (the index) in D1.
const cf = cloudflare(rt, { binding: "CONNECTION", db: "INDEX" });
export class Connection extends cf.ConnectionDO {}
export default { fetch: cf.fetch };
```

```json title="wrangler.json"
{
  "name": "my-connectd",
  "main": "worker.ts",
  "compatibility_date": "2026-10-01",
  "version_metadata": { "binding": "CF_VERSION_METADATA" },
  "durable_objects": { "bindings": [{ "name": "CONNECTION", "class_name": "Connection" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Connection"] }],
  "d1_databases": [{ "binding": "INDEX", "database_name": "my-connectd-index", "database_id": "…", "migrations_dir": "node_modules/@kavishkagaya/connectd/kernel/migrations" }]
}
```

Leaving out an extension turns its feature off. Each built-in one is also a no-op until its settings are present (no `events` setting, no deliveries). Using `connectd deploy --dry-run` and reading `.connectd/deploy/` is a quick way to see a working Worker entry and config.

### Settings

| Field | Needed for |
| --- | --- |
| `keys` | Sealing credentials. `importKeys({ 1: k1, 2: k2 }, 2)`: the second argument is the current version. |
| `stateKey` | OAuth `state` and tickets |
| `apiKey` | Bearer auth on non-public routes |
| `redirectUri` | `<public URL>/callback`, registered with providers |
| `config` | Connector config per definition id. `null` for definitions without config (API keys). |
| `events?` | `{ url, secret }`: event delivery |
| `webhooks?` | `{ url, key }`: the ingress URL, and the key per-connection secrets derive from |
| `sessions?` | `{ key, origins }`: the browser connect UI |

Unlike the CLI, `runtime()` doesn't read `.config((env) => …)` for you. Pass each connection's config in `settings.config`. Or use `options(config, platform.env)` from `@kavishkagaya/connectd`, which is exactly what the generated Worker does: it resolves an `oc.config.ts` against the platform's env, name by name, and returns everything `runtime()` takes.

Outbound HTTP (providers, the proxy, event delivery) and logs are the platform's: `platform.fetch` and `platform.log`. In tests, give the memory platform a fake: `memory(rt.program, { fetch })`.

## On a Node server, in memory

The memory platform isn't durable on its own, but `dump()` and `snapshot` save and restore it. That's how `connectd dev` works:

```ts
import { createServer } from "node:http";
import { memory } from "@kavishkagaya/connectd/kernel/memory";
import { runtime /* , … */ } from "@kavishkagaya/connectd/runtime";

const rt = runtime({ definitions, settings, extensions: [/* …, */ directory()] });
const world = memory(rt.program, { clock: Date.now, env: process.env });   // real clock: timers fire on their own

// Any Request → Response server works; this is the whole bridge:
const handle = (req: Request) => rt.fetch(req, world.platform);
```

Keep it to dev, demos and tests. Production wants a durable platform.

## Writing a platform

A platform implements the [L0 contract](/concepts/architecture/#l0--platform-infrastructure-only): the `Atom` (per connection: `store`, named durable `timer`s, `now()`) and the `Platform` (per deployment: `env`, `fetch`, `log`, `defer`, `atoms.call`/`destroy`, the `db` management operations, `limits`, `version`). Then host `Program`s on it:

```ts
import type { Atom, Platform, Program } from "@kavishkagaya/connectd/kernel";

// Your platform's equivalent of "one actor per key, with storage and an alarm", plus the deployment around it.
export function myPlatform(program: Program) { /* one Atom per name, a single owner each; route calls and timer fires to program(atom, platform) */ }
```

The properties that matter most:

- **One live handler per atom name** across the deployment. On a server, that means leases.
- **Each store operation is atomic** against other events on the same atom. `cas` compares versions, so there's no ABA problem, even across a `destroy`.
- **Timers survive restarts** and fire roughly on time, with at least one delivery.

Prove it with the two shared parity suites, the same ones the memory and Cloudflare platforms pass:

```ts
import { parity, platformParity, probe } from "@kavishkagaya/connectd-kernel/parity";
import { expect, test } from "vitest";

parity("my platform", () => makeWorld(myPlatform(probe)), { test, expect });
platformParity("my platform", () => makeWorld(myPlatform(probe)), { test, expect });
```

A Postgres or SQLite-backed server platform is on the roadmap. If you'd like to build it, see [contributing](/contributing/overview/).
