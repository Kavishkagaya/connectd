---
title: Local dev and the dashboard
description: connectd dev, tunnels for webhooks, saved state, and the built-in dashboard.
sidebar:
  order: 10
---

## `connectd dev`

```sh
npx connectd dev
```

```text
connectd dev
  URL           http://localhost:8787
  API key       oc_…   (CONNECTD_API_KEY in .env)
  public URL    http://localhost:8787   (https-only providers like Slack need --tunnel or --url)
  callback URL  http://localhost:8787/callback   (register this redirect URI with each OAuth provider)
  webhooks      http://localhost:8787/webhooks/:def[/:id]
  events        http://localhost:3000/api/connectd/events   (verify with CONNECTD_EVENTS_SECRET from .env)
  sessions      http://localhost:3000
  dashboard     http://localhost:8787/dashboard   (sign in with the API key)
  definitions   github, slack
  no config     slack (SLACK_CLIENT_ID, SLACK_CLIENT_SECRET)   (answer not_configured until .env has them)
  env           GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET   (from .env; nothing else reaches the runtime)
  state         .connectd/state.json   (--reset to start empty)
```

It prints one line per request after that, and `reloaded: …` when you save a file.

- The full runtime (every extension) runs **in memory** on a real clock: timers fire, tokens refresh, and events are delivered.
- State is saved to `.connectd/state.json` and restored on start, so connections survive restarts. `--reset` starts empty.
- The config and the connection folders are bundled with esbuild and **swapped in place on save**, without losing state. The watcher ignores build output, hidden folders and generated types.
- Keys come from `.env` (written by `connectd init`). `dev` never creates keys itself.
- The port comes from `CONNECTD_URL` in `.env` (default 8787), or `--port`.

Run your app next to it in another terminal. `dev` doesn't start your app.

## Webhooks in dev: tunnels

Providers can't reach `localhost`. Expose dev on a public https URL:

```sh
npx connectd dev --tunnel                    # starts a cloudflared quick tunnel, prints its URL
npx connectd dev --url https://abc.ngrok.app # a tunnel you run yourself
```

The callback and webhook URLs then use the public URL. Remember to add `<tunnel>/callback` to your OAuth app. Slack's Events API requires https, so it needs this.

## The dashboard

Every deployment serves a dashboard at `/dashboard`: dev, and each deployed Worker. Sign in with that environment's `CONNECTD_API_KEY`. The key stays in the tab's `sessionStorage`.

What it shows:

- **Overview.** Each connection definition: whether it's configured (missing env names, never values), the proxy base URL, and which webhook URLs to register with the provider.
- **Connections.** Search and filter by definition, state and external id. Each connection shows its state, reason, identity, event queue (pending, last error, recent deliveries with **redeliver**), webhook registration and subscriptions, and actions with their next run.
- **Actions.** Run any action with a form generated from its input schema (zod 4, valibot and arktype export JSON Schema).
- **Failures.** Recent failed scheduled actions across all connections.

Nothing the dashboard serves contains a secret: no credentials, tokens, config values, keys or webhook secrets. The page has a strict CSP. Turn it off with `dashboard: false` in `oc.config.ts`.
