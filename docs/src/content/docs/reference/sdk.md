---
title: SDK
description: "@kavishkagaya/connectd/sdk (server) and @kavishkagaya/connectd-connect (browser): every function and option."
sidebar:
  order: 2
---

## `@kavishkagaya/connectd/sdk`

The server SDK. It uses fetch only, with no Node APIs, so it runs on Node 18+, Bun, Workers and Deno.

### `connectd(options?)`

```ts
import { connectd } from "@kavishkagaya/connectd/sdk";
const oc = connectd({ user, listeners });
```

| Option | Default | |
| --- | --- | --- |
| `url` | `CONNECTD_URL` | The runtime's base URL |
| `apiKey` | `CONNECTD_API_KEY` | |
| `user` | | `(req) => userId \| null`, for `oc.routes`. Ids can't contain `:`. |
| `listeners` | | The folders' `listen()` handlers: `import { listeners } from "../.connectd/app"` |
| `events` | | `{ secret?, dedupe?, toleranceSec? }` for `oc.routes`' events (secret default: `CONNECTD_EVENTS_SECRET`) |
| `origin` | `req.url`'s | Your app's public origin, when behind a proxy |
| `fetch` | global `fetch` | |

Environment values are read on first use, so importing the client before the env is set is fine. The client is typed from `.connectd/registry.d.ts`: unknown connection ids, actions and event types don't compile.

### `oc.connection(definition, id)`

| Method | Returns | |
| --- | --- | --- |
| `status()` | `{ state, reason?, metadata }` | `metadata` is typed from `.identity()` |
| `fetch(path, init?)` | `Response` | Through the proxy. `init.retry: true \| { attempts, maxWaitMs }` retries connectd's own 429s. |
| `actions.<name>(input?)` | the action's output | Typed per action |
| `connect(args?)` | `{ url, device? }` | Server-side start. `url: null` when it finished inline. |
| `session({ origin?, returnUrl?, ttlMs? })` | `{ token, expiresAt, flow }` | A browser session token for `@kavishkagaya/connectd-connect` |
| `link({ next?, ttlMs?, confirm? })` | `{ url, expiresAt }` | A single-use link to the hosted connect page |
| `token()` | `Credential` | The raw credential, refreshed if due. Prefer `fetch`. |
| `revoke(reason?)` | status | Unregisters webhooks, revokes at the provider, marks revoked |
| `webhooks.subscribe(input)` | `Subscription` | For definitions with a `subscription` schema |
| `webhooks.list()` | `Subscription[]` | |
| `webhooks.unsubscribe(id)` | `null` | |
| `call(method, args?)` | JSON | Any other method: `events.status`, `events.flush`, `events.redeliver`, `webhooks.status`, `webhooks.endpoint`, `actions.status`, `index.sync` |

### `oc.connections`

```ts
const page = await oc.connections.page({ def, state, q, external: { key, value }, cursor, limit });
// { connections: Row[], cursor: string | null }

for await (const row of oc.connections.list({ state: "active" })) { … }   // follows cursors
```

A `Row` is `{ def, id, state, reason, external, createdAt, updatedAt, version }`.

### `oc.routes`

```ts
export const { GET, POST } = oc.routes;   // mounted at any path, e.g. /api/connectd/[...path]
```

| Route | |
| --- | --- |
| `GET <base>/connect/:def?account=&return=` | Starts connecting the signed-in user, then redirects to the provider |
| `GET <base>/return` | Where the flow comes back: a page that confirms, then goes to `return` |
| `POST <base>/return` | That page's confirmation, checked against `user(req)` |
| `POST <base>/events` | Signed events, dispatched to `listeners` |

### `oc.events({ secret, dedupe?, toleranceSec?, now? })`

```ts
const ev = oc.events({ secret: process.env.CONNECTD_EVENTS_SECRET! });
ev.on("connection.active", async (event, conn) => { … });   // conn: a connection client
ev.on("*", (event) => { … });
export const POST = (req: Request) => ev.handle(req);       // 204 · 401 bad signature · 500 handler threw
```

`dedupe` is `{ has(id), add(id) }`. It's checked before handlers and recorded after they all succeed.

### `listen(id)`

```ts
export default listen("github").on("connection.active", handler).on("webhook.push", handler);
```

The default export of a folder's `events.ts`. Typed to that connection's events.

### `ConnectdError`

Thrown for anything the runtime refused: `{ code, status, message, state?, reason?, retryAfterMs? }`. A non-JSON failure in front of the runtime is `code: "http_error"`. See [error codes](/reference/http-api/#errors).

### `@kavishkagaya/connectd/sdk/node`

```ts
import { toNode } from "@kavishkagaya/connectd/sdk/node";
app.post("/connectd/events", toNode(ev.handle));   // mount before express.json(), or after express.raw()
```

### Types

`Status`, `Subscription`, `Retry`, `ProxyInit`, `Client`, `Connection` (untyped), `EventType`, `EventOf<"connection.active">`, `Registry`, `RegistryOf`.

---

## `@kavishkagaya/connectd-connect`

The browser package. Zero dependencies, DOM only.

:::note
Not published yet.
:::

### `mount(element, options)`

A prebuilt connect button, or a form for API-key definitions. Returns `unmount`.

| Option | |
| --- | --- |
| `url` | The runtime's URL |
| `token` | A session token, or `() => Promise<string>` (fetched again near expiry) |
| `mode` | `"popup"` (default) or `"redirect"` |
| `label` | Button text (default `Connect <definition>`, or `Reconnect` once active) |
| `onResult(result)` | Called with the outcome |
| `fallback`, `timeoutMs`, `signal`, `onClosed` | As for `connect()` |

Unstyled, with `oc-*` classes. On a redirect return URL it runs `resume()` first.

### `connect(options)` → `Result`

| Option | Default | |
| --- | --- | --- |
| `url` | | The runtime's URL |
| `token` | | Session token, or a function returning one. The popup opens first, then waits for it. |
| `mode` | `popup` | `redirect` needs a session with `returnUrl` |
| `fields` | | API-key input. Submitted with fetch, and no window opens. |
| `fallback` | `true` | Redirect when the popup is blocked (if there's a `returnUrl`) |
| `timeoutMs` | 10 min | Give up on the popup |
| `signal` | | Abort (closes the popup, gives `error: aborted`) |
| `onClosed()` | | Called when the popup reads as closed |

`Result` is `{ status: "connected" }`, `{ status: "error", code, message }`, `{ status: "closed" }` or `{ status: "redirecting" }`.

### `resume({ url, token })` → `Result | null`

On the return URL page in redirect mode. Gives `null` when there's no outcome in the URL.

### `session({ url, token })` → `SessionInfo`

What to render: `{ definition, id, flow: "redirect" | "form", fields, state, reason?, expiresAt }`.

### `claims(token)`

Reads a session token's (signed, not secret) claims: `{ def, id, exp, origin, returnUrl? }`.
