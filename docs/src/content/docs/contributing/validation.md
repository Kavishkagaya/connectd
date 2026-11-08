---
title: Validating a change
description: The checks to run before a change merges, from the unit tests to a real deploy, the way a developer uses connectd.
sidebar:
  order: 2
---

Unit tests prove each piece. This page is the check that the pieces work together the way a developer meets them: an npm install, `init`, `dev`, the SDK, `keys`, the dashboard, `deploy`. Run the parts your change touches before it merges, and all of it before a release. Say in the PR what you ran.

| Level | What | Time | Needs |
| --- | --- | --- | --- |
| 1 | `bun run typecheck` and `bun run test` | a few minutes | Bun |
| 2 | `scripts/e2e/run.sh`: the developer walkthrough, local | about 2 minutes | Bun, Node 22.5+, npm; Playwright for the browser part |
| 3 | A real Cloudflare deploy and redeploy | about 10 minutes | a Cloudflare account |
| 4 | A real provider, a real browser, a real passkey | about 10 minutes | a GitHub OAuth app, a device with a passkey |

## 1. Types and tests

```sh
bun run typecheck
bun run test
```

Both must pass on every PR.

## 2. The developer walkthrough

```sh
scripts/e2e/run.sh
# with the dashboard in a real browser:
PLAYWRIGHT=/path/to/playwright-core/index.mjs CHROME=/usr/bin/google-chrome scripts/e2e/run.sh
# keep the project afterwards to look around (its path is printed):
KEEP=1 scripts/e2e/run.sh
```

It packs the two published packages, installs the tarballs with npm in a new project, and runs everything on Node, the way a developer's project does. Nothing reaches Cloudflare or GitHub. Each check prints `PASS` or `FAIL`, and the script stops at the first failure.

| Step | Checks |
| --- | --- |
| Install | `npx connectd` runs on Node from the tarball |
| `init`, `add` | the root key and `oc.config.ts` are written; running `init` again keeps the root key; `add github` copies the provider |
| `dev` | dev writes the app's API key and events secret into `.env`; no key and a wrong key get 401, the app's key gets 200; through the SDK, `connect` returns GitHub's authorize URL, `status` is `pending` and `connections.list` shows the connection |
| `keys` against dev | `create` shows the secret once, and the key works; `ls` never shows a secret; `roll --grace` keeps the old secret working, `revoke` stops it; `--events` finds the events secret by name; **`keys` never changes `.env`** |
| `dashboard --print` | prints a sign-in link |
| dev restarts | a restart leaves `.env` alone and keeps the connection; `--reset` empties the connections but keeps the keys |
| `deploy` | `--dry-run` generates the Worker; a derived key in the env file is refused |
| The deployed Worker | the generated Worker runs on `wrangler dev` (local Durable Objects and D1), with the secrets a deploy would set: a fresh deployment has no keys; `keys create` through `/admin` makes the app's; the SDK works with them; dev's key gets 401 there; another project's root key is refused; after a restart, the keys and the connection are still there |
| Browser (with `PLAYWRIGHT`) | the CLI link signs in and asks for an account; an account made with a password; the connection and the CLI's keys show on their pages; sign out and back in; no CSP violation or page error |

The helpers live next to the script: `app.mjs` (the app's SDK calls), `worker-vars.mjs` (the Worker's secrets, derived as `deploy` derives them) and `browser.mjs`. When a change adds something a developer does, add a step here too.

## 3. A real deploy and redeploy

This is the part the local Worker can't show: what `deploy` does to a Worker that already exists. Use a scratch project (`KEEP=1 scripts/e2e/run.sh` leaves one) and a Cloudflare account (`npx wrangler login`).

```sh
npx connectd deploy                 # first deploy
npx wrangler secret list --name <worker>
npx connectd deploy                 # redeploy
npx connectd deploy --rotate key
```

- [ ] The first deploy prints the app's `CONNECTD_URL`, `CONNECTD_API_KEY` and `CONNECTD_EVENTS_SECRET` once. With them in an app's env, `node --env-file=<file> app.mjs` passes against the Worker.
- [ ] `secret list` shows `CONNECTD_KEY_V1`, `CONNECTD_STATE_KEY`, `CONNECTD_SESSIONS_KEY`, `CONNECTD_WEBHOOKS_KEY` and `CONNECTD_ADMIN_KEY`, plus the project's own names. It never shows `CONNECTD_ROOT_KEY`.
- [ ] **A redeploy changes no key.** Its `secrets set` line lists only the project's own names, no `CONNECTD_*`. The app's key still works, and a connection made before still reads as it was (`status`, `token`).
- [ ] **A redeploy with another root key changes nothing either.** Put a different `CONNECTD_ROOT_KEY` in the shell and deploy: `secrets set` has no `CONNECTD_*` names, the app keeps working, and the CLI reports that the deployment's keys "aren't this root key's".
- [ ] `--rotate key` sets `CONNECTD_KEY_V2` and nothing else. V1 stays, and old connections still read.
- [ ] `connectd keys --env production` lists the keys, and `connectd dashboard --env production` opens the dashboard signed in.
- [ ] `--env staging` makes its own Worker and database, and its own keys: production's API key gets 401 there.
- [ ] A CI-style deploy (`CI=true`, the root key and the provider secrets in the shell, `.connectd/` deleted, `--url` passed) deploys the same Worker, and its keys still work.

Delete the scratch Workers and databases when you're done (`wrangler delete`, `wrangler d1 delete`).

## 4. A real provider and a real browser

- [ ] **OAuth for real:** `examples/nextjs` with a GitHub OAuth app (`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in its `.env`, the callback registered as `http://localhost:8787/callback`). Connect from the app's page, approve at GitHub, and land back on the app with the connection `active`. `token` and a `/proxy` call work, and the app receives the `connection.active` event, signed with its `CONNECTD_EVENTS_SECRET`.
- [ ] **Passkeys:** `PLAYWRIGHT=… CHROME=… bun packages/dashboard/e2e/chromium.ts` (Chrome's virtual authenticator). Once per release, also make an account with a real passkey on a real device, then sign out and back in with it.
- [ ] **Connect UI in a browser**, when `packages/connect` changed: `bun packages/connect/e2e/chromium.ts`.
- [ ] **Tunnel**, when `tunnel.ts` or webhooks changed: `connectd dev --tunnel` (cloudflared installed), and the printed public URL serves `/callback`.
