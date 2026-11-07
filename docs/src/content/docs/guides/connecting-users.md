---
title: Connecting users
description: Three ways to start a connection. A link through oc.routes, your own connect UI in the browser, or from your server.
sidebar:
  order: 4
---

There are three ways to get a user from "not connected" to `active`. They all end in the same place. connectd draws no connect screens of its own: the buttons and forms are your app's, in your design.

| Way | Use when | You write |
| --- | --- | --- |
| [**A link through `oc.routes`**](#1-a-link-through-ocroutes) | The user is in your web app. The default. | An `<a href>` |
| [**Your connect UI in the browser**](#2-your-connect-ui-in-the-browser) | You want a popup, or a form inside a page | `connect()` |
| [**From your server**](#3-from-your-server) | API keys your form collected, device codes, scripts | `connect()` |

## Connection ids

A connection is `(definition, id)`. With `oc.routes`, the id is **your signed-in user's id**. For a second account of the same provider, add `?account=work`, which gives the id `<user>:work`. That's why user ids can't contain `:`.

```ts
oc.connection("github", "alice")        // alice's GitHub
oc.connection("github", "alice:work")   // alice's other GitHub account
```

## 1. A link through `oc.routes`

The simplest flow, and the one `connectd init` sets up. Mount the route once:

```ts title="app/api/connectd/[...path]/route.ts"
import { oc } from "@/lib/oc";
export const { GET, POST } = oc.routes;
```

Then link to it from any page:

```html
<a href="/api/connectd/connect/github?return=/settings">Connect GitHub</a>
<a href="/api/connectd/connect/github?account=work&return=/settings">Connect another GitHub account</a>
```

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant R as oc.routes (your app)
  participant C as connectd
  participant P as Provider
  B->>R: GET /connect/github?return=/settings
  R->>R: user(req) → "alice"
  R->>C: session for github/alice (returnUrl = /return)
  R-->>B: 303 → connectd /session/authorize?ticket=…
  B->>C: sets the binding cookie
  C-->>B: 302 → provider
  B->>P: approve
  P->>C: /callback
  C-->>B: → your /return#connectd=authorized&completion=…
  B->>R: POST /return (completion), from your page
  R->>R: user(req) must still be "alice"
  R->>C: complete → active
  R-->>B: → /settings?connectd=connected&definition=github&id=alice
```

When it finishes, the user lands on `return` with `?connectd=connected&definition=github&id=alice`, or with `?connectd=error&code=access_denied`. Treat that as a hint for the UI, and call `status()` before trusting it.

The link is for OAuth definitions. For API-key definitions, collect the key in your own form and connect [from your server](#3-from-your-server); the link answers `400` for them.

**What `oc.routes` checks for you:**

- The connect link only works from your own pages (`Sec-Fetch-Site`), so another site can't start a connection for your user.
- The flow is bound to this browser by a cookie.
- The completion is confirmed only from your page, and only for the user who started it.
- `return` must be a path on your own origin. Anything else becomes `/`.

Your app's origin must be in `sessions.origins` in `oc.config.ts`.

## 2. Your connect UI in the browser

:::note
`@kavishkagaya/connectd-connect` isn't published yet. Until it is, connect with a link to `oc.routes` (above).
:::

`@kavishkagaya/connectd-connect` is a zero-dependency, headless browser package: it runs the popup or redirect flow, and your page draws the button. Your backend creates a short-lived **session token**, and the browser uses only that.

```ts title="server: an endpoint your page calls"
export async function POST(req: Request) {
  const user = await requireUser(req);
  const { token } = await oc.connection("github", user.id).session({ origin: "https://app.example.com" });
  return Response.json({ token });
}
```

Wire your own button to `connect()`:

```ts
import { connect, resume } from "@kavishkagaya/connectd-connect";

button.onclick = async () => {
  const r = await connect({ url, token: getToken, mode: "popup" });
  // r.status: "connected" | "error" (r.code) | "closed" | "redirecting"
};

// redirect mode: on the page the session's returnUrl points to
const r = await resume({ url, token });
```

- **Popup** (the default) opens a blank window first, so blockers allow it. If the popup is blocked and the session has a `returnUrl`, it falls back to a redirect.
- **Redirect** needs `session({ returnUrl })`, and the return page calls `resume()`.
- **API keys:** `connect({ url, token, fields: { key: "…" } })` submits the form with fetch, and no window opens.

## 3. From your server

```ts
const gh = oc.connection("github", user.id);

// OAuth: a provider URL (server-side flows only, see the warning below)
const { url } = await gh.connect();

// API key from your own form (or one you already hold): finishes inline, url is null
await oc.connection("notes", user.id).connect({ key: "sk_live_…" });

// device flow: show the code, connectd polls
const { device } = await oc.connection("acme", user.id).connect();

// client credentials / JWT bearer: no user, finishes inline
await oc.connection("internal-api", "app").connect();
await oc.connection("gcal-sa", "ops").connect({ subject: "ops@example.com" });
```

:::caution
The URL from `connect()` isn't tied to a browser. If it reaches someone else, *their* provider account can land on *your* user's connection (login CSRF). For users in a browser, use `oc.routes` or `connect()` from the browser package.
:::

## Checking and ending connections

```ts
const s = await gh.status();
// { state: "active", metadata: { id: "123", login: "alice" } }
// { state: "reauth_required", reason: "invalid_grant", metadata: … }

await gh.revoke();                 // unregister webhooks, revoke at the provider, mark revoked
await gh.revoke("user_deleted");   // with your own reason
```

`status()` on a connection that was never started throws `ConnectdError` with `code: "not_found"`. A revoked connection is final: to connect again, use a new id.

## Listing connections

```ts
for await (const c of oc.connections.list({ def: "github", state: "reauth_required" })) {
  console.log(c.id, c.reason, c.external);
}

const page = await oc.connections.page({ external: { key: "teamId", value: "T0123" }, limit: 50 });
```

The list comes from the connection index: state, reason, external ids and timestamps, never credentials.
