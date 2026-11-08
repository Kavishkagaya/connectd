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
  API key       ock_1a2b3c4d5e6f…   (CONNECTD_API_KEY in .env; `connectd keys` manages them)
  public URL    http://localhost:8787   (https-only providers like Slack need --tunnel or --url)
  callback URL  http://localhost:8787/callback   (register this redirect URI with each OAuth provider)
  webhooks      http://localhost:8787/webhooks/:def[/:id]
  events        http://localhost:3000/api/connectd/events   (signed: verify with CONNECTD_EVENTS_SECRET from .env)
  sessions      http://localhost:3000
  dashboard     http://localhost:8787/dashboard   (`connectd dashboard` opens it signed in)
  definitions   github, slack
  no config     slack (SLACK_CLIENT_ID, SLACK_CLIENT_SECRET)   (answer not_configured until .env has them)
  env           GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET   (from .env; nothing else reaches the runtime)
  state         .connectd/state.json   (--reset to start empty; keys and accounts stay in dev.db)
```

It prints one line per request after that, and `reloaded: …` when you save a file.

- The full runtime (every extension) runs **in memory** on a real clock: timers fire, tokens refresh, and events are delivered.
- State is saved to `.connectd/state.json` and restored on start, so connections survive restarts. `--reset` starts empty. If the config fails to load on start, the file is left as it was and its timers wait for the first good load.
- The config and the connection folders are bundled with esbuild and **swapped in place on save**, without losing state. The watcher ignores build output, hidden folders and generated types.
- Its keys derive from the project's root key, `CONNECTD_ROOT_KEY` in `.env` (written by `connectd init`).
- API keys, events secrets and dashboard accounts live in SQLite, `.connectd/dev.db`, so they outlive restarts and `--reset`. dev writes your app's `CONNECTD_API_KEY` (and `CONNECTD_EVENTS_SECRET`, when events are on) into `.env` when they're missing or no longer valid. More keys: `connectd keys create <name>`, which prints the secret for you to put where it's used (it doesn't touch `.env`).
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

Every deployment serves a dashboard at `/dashboard`: dev, and each deployed Worker.

```sh
npx connectd dashboard                    # dev
npx connectd dashboard --env production   # a deployment
```

That opens it signed in, with a one-time link the CLI signs. The dashboard then asks you to make an account, with a **passkey** (suggested) or a password, so later sign-ins need no CLI: from any browser, or a teammate you invite from the Accounts page. Signing in is a cookie: no key ever sits in the browser.

What it shows:

- **Overview.** Each connection definition: whether it's configured (missing env names, never values), the proxy base URL, and which webhook URLs to register with the provider.
- **Connections.** Search and filter by definition, state and external id. Each connection shows its state, reason, identity, event queue (pending, last error, recent deliveries with **redeliver**), webhook registration and subscriptions, and actions with their next run.
- **Actions.** Run any action with a form generated from its input schema (zod 4, valibot and arktype export JSON Schema).
- **Failures.** Recent failed scheduled actions across all connections.
- **Keys.** The deployment's API keys and events secrets: make, roll (with a grace period) and revoke them. A new secret is shown once, with the env lines to paste into your app.
- **Accounts.** Who can sign in: your passkeys and password, other accounts, and one-time invite links.

Nothing the dashboard serves contains a secret: no credentials, tokens, config values or webhook secrets, and a key's secret only once, to whoever made it. The page has a strict CSP. Turn it off with `dashboard: false` in `oc.config.ts`.
