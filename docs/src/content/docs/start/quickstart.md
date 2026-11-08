---
title: Quickstart
description: Add connectd to a Next.js app and connect GitHub, running locally.
sidebar:
  order: 2
---

In about ten minutes: your users click **Connect GitHub**, approve, and your app lists their repositories through connectd. Nothing GitHub-specific is stored in your app.

## What you'll build

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant N as Your Next.js app (:3000)
  participant C as connectd dev (:8787)
  participant G as GitHub
  B->>N: click "Connect GitHub"
  N->>C: start a session for user "alice"
  C-->>B: redirect to GitHub (bound to this browser)
  B->>G: approve
  G->>C: /callback?code=…
  C-->>B: back to your app's /return page
  B->>N: confirm (as alice)
  N->>C: complete: the connection is now active
  C-->>N: event: connection.active
  N->>C: gh.fetch("/user/repos")
  C->>G: GET /user/repos + token
```

## 1. Prerequisites

- Node.js 22 or later (or Bun 1.3+)
- A Next.js app using the App Router. Any framework with `Request → Response` handlers works the same way; Next.js just gets its files generated for you.
- A GitHub account

## 2. Set up

In your app's folder:

```sh
npx @kavishkagaya/connectd init
```

In a terminal it's a step-by-step setup (Enter keeps the default):

```text
1. Your app's origin in dev [http://localhost:3000]:
2. Port for connectd dev [8787]:
3. Install @kavishkagaya/connectd (your app imports its SDK; the connectd CLI comes with it)? [Y/n]
4. Where will connectd run when you deploy?
     1) Cloudflare Workers  (installs @kavishkagaya/connectd-cloudflare and wrangler)
     2) Decide later
   → then, if wrangler isn't logged in: Log in now (opens your browser)? [Y/n]
5. Providers to add  (↑/↓ move, space ticks, enter confirms)
   › [x] github        GitHub OAuth app: user tokens, the REST API, repo webhook subscriptions
     [ ] google        Google OAuth (OIDC): Calendar and the Google APIs, calendar watch channels
     [ ] slack         Slack OAuth v2: bot and user tokens, Events API webhooks
     [ ] github-app    GitHub App: one installation per connection, minted installation tokens
     [ ] Add later     connectd add <provider>, or --custom for your own
```

Every flag answers its question (`--app-url`, `--port`, `--target`, `--add github,slack`), and `--yes` asks nothing: the flags, then `.env`, then the defaults. Without a terminal (CI) it never asks.

`@kavishkagaya/connectd` is the `connectd` command (`init`, `add`, `dev`, `deploy`) and everything your code imports, so it's a dependency of your app. The deploy target is its own package, since it's the part you can swap; wrangler is a dev dependency of your app too, never global.

| Import | What it's for |
| --- | --- |
| `@kavishkagaya/connectd` | `defineConfig` for `oc.config.ts` |
| `@kavishkagaya/connectd/sdk` | The client your app uses: `connectd()`, `oc.routes`, `listen()` |
| `@kavishkagaya/connectd/connections` | What connection files import: `connection()`, `action()` |
| `@kavishkagaya/connectd-cloudflare` | The deploy target for `connectd deploy` |

## 3. What init wrote

`init` writes only what's missing and never overwrites:

```text
.env                                    the root key, CONNECTD_URL, APP_URL
.gitignore                              adds .env (it holds the root key now)
oc.config.ts                            the project config
src/lib/oc.ts                           the client
src/app/api/connectd/[...path]/route.ts one route: connect, return, events
```

`.env` is shared: your app reads `CONNECTD_URL`, `CONNECTD_API_KEY` and `CONNECTD_EVENTS_SECRET` from it (`connectd dev` writes the two keys on its first run), and `connectd dev` reads the rest. Keep a copy of `CONNECTD_ROOT_KEY` in your password manager: every environment's keys derive from it.

## 4. GitHub

If you didn't tick it in the setup:

```sh
npx connectd add github
```

Either way, this copies the GitHub provider into `src/oc/github/connection.ts`, adds an empty `src/oc/github/events.ts`, and appends `GITHUB_CLIENT_ID=` and `GITHUB_CLIENT_SECRET=` to `.env`. The file is now yours to read and change. See [providers are code](/concepts/providers-as-code/).

Create a GitHub OAuth app at **github.com/settings/developers → OAuth Apps → New OAuth App**:

- **Homepage URL:** `http://localhost:3000`
- **Authorization callback URL:** `http://localhost:8787/callback`

Put its client ID and a new client secret in `.env`:

```sh title=".env"
GITHUB_CLIENT_ID=Ov23li…
GITHUB_CLIENT_SECRET=…
```

:::tip
The callback goes to **connectd** (port 8787), not to your app. connectd does the code exchange, then sends the user back to your app.
:::

## 5. Tell connectd who is signed in

Open `src/lib/oc.ts` and return your signed-in user's id. That id becomes the connection id, so every user gets their own GitHub connection:

```ts title="src/lib/oc.ts"
import { connectd } from "@kavishkagaya/connectd/sdk";
import { listeners } from "../../.connectd/app";

export const oc = connectd({
  user: async (req) => (await getSession(req))?.userId ?? null, // your auth here
  listeners,
});
```

The generated route needs no changes:

```ts title="src/app/api/connectd/[...path]/route.ts"
import { oc } from "@/lib/oc";
export const { GET, POST } = oc.routes;
```

## 6. Use the connection

```tsx title="src/app/page.tsx"
import { oc } from "@/lib/oc";

export default async function Page() {
  const user = await currentUserId(); // your auth here
  const gh = oc.connection("github", user);
  const status = await gh.status().catch(() => null);

  if (status?.state !== "active")
    return <a href="/api/connectd/connect/github?return=/">Connect GitHub</a>;

  const repos = await (await gh.fetch("/user/repos?sort=updated")).json();
  return (
    <ul>
      {repos.map((r: { full_name: string }) => <li key={r.full_name}>{r.full_name}</li>)}
    </ul>
  );
}
```

`gh.fetch` goes through connectd's proxy, which adds the token, refreshes it if it's due, and applies GitHub's rate limits. Your app never sees the token.

## 7. React to events

```ts title="src/oc/github/events.ts"
import { listen } from "@kavishkagaya/connectd/sdk";

export default listen("github")
  .on("connection.active", (e) => console.log(`github connected for ${e.connection.id}`))
  .on("connection.reauth_required", (e) => console.log(`github needs a new login for ${e.connection.id}`));
```

These handlers run in your app. They get there through the route from step 5, signed and verified.

## 8. Run it

In two terminals:

```sh
npx connectd dev      # the runtime on :8787
```

```sh
npx next dev          # your app on :3000
```

Open http://localhost:3000, sign in, and click **Connect GitHub**.

`connectd dev` runs the whole runtime in memory with a real clock. It keeps state in `.connectd/state.json`, so connections survive restarts, and it reloads when you save a connection file. The dashboard is at http://localhost:8787/dashboard. Sign in with `CONNECTD_API_KEY` from `.env`.

## A complete example

[`examples/nextjs`](https://github.com/Kavishkagaya/connectd/tree/main/examples/nextjs) in the repository is this quickstart, finished: demo sign-in, status, disconnect, and the repository list.

## Next steps

- [The mental model](/concepts/mental-model/): what a connection is, and why it works this way.
- [Defining connections](/guides/defining-connections/): read and change `connection.ts`.
- [Deploying](/guides/deploying/): `npx connectd deploy` to your Cloudflare account.
