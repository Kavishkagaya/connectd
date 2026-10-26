---
title: CLI
description: Every connectd command and flag.
sidebar:
  order: 1
---

```sh
npx connectd <command> [flags]
```

Runs on Node 22+ or Bun. `npx connectd --help` prints this list.

| Command | Does |
| --- | --- |
| [`init`](#connectd-init) | Sets up dev in your app: keys, `CONNECTD_URL` and `APP_URL` in `.env`, `oc.config.ts`, `lib/oc.ts`, the route |
| [`dev`](#connectd-dev) | Runs the runtime locally: in memory, real clock, state in `.connectd/`, reloads on save |
| [`add`](#connectd-add) | Copies a provider into the project, or creates a custom one |
| [`diff`](#connectd-diff) | Shows what changed upstream in a copied provider |
| [`deploy`](#connectd-deploy) | Deploys to your Cloudflare account, through wrangler |
| [`types`](#connectd-types) | Writes `.connectd/registry.d.ts` and `.connectd/app.ts` |
| [`keys`](#connectd-keys) | Prints a new `CONNECTD_API_KEY` and `CONNECTD_EVENTS_SECRET` |
| `help` | Prints the help text |

## `connectd init`

Writes only what's missing, and never overwrites:

- `.env`: `APP_URL`, `CONNECTD_URL`, and dev's keys (`CONNECTD_API_KEY`, `CONNECTD_EVENTS_SECRET`, `CONNECTD_KEY_V1`, `CONNECTD_STATE_KEY`, `CONNECTD_SESSIONS_KEY`, `CONNECTD_WEBHOOKS_KEY`). It's made owner-only (`0600`).
- `.gitignore`: adds `.env`. It refuses to write keys into a `.env` that git tracks.
- `oc.config.ts`, `<src>/lib/oc.ts`, and for Next.js (App Router) `app/api/connectd/[...path]/route.ts`.
- The deploy target, for a new `oc.config.ts`: asked in a terminal (or `--target`). For Cloudflare it installs `@kavishkagaya/connectd-cloudflare` and `wrangler` as dev dependencies, with your lockfile's package manager (else the one that ran it, else npm), and writes `target: cloudflare({ name })`. Already installed: used without asking.

| Flag | |
| --- | --- |
| `--port <n>` | Where `connectd dev` will run (default 8787), written as `CONNECTD_URL` |
| `--app-url <url>` | Your app's origin (default `APP_URL` from `.env`, else `http://localhost:3000`) |
| `--target <t>` | Where it deploys: `cloudflare`, or `none` to decide later (default: asked in a terminal; none in CI) |
| `--skip-install` | Write the target into the config without installing its packages |

Keys an older `connectd dev` kept in `.connectd/dev.vars` are moved to `.env`, so sealed credentials stay readable.

## `connectd dev`

| Flag | |
| --- | --- |
| `--port <n>` | Port (default: `CONNECTD_URL`'s in `.env`, else 8787; `0` picks a free one) |
| `--config <file>` | Config file (default `oc.config.ts`) |
| `--tunnel` | Expose it on a public https URL with a cloudflared quick tunnel (Slack needs https) |
| `--url <url>` | The public URL of a tunnel you run yourself. Callback and webhook URLs use it. |
| `--reset` | Start from empty state |

See [local dev](/guides/local-dev/).

## `connectd add`

```sh
connectd add                       # list the catalog
connectd add <provider>            # copy it into <dir>/<provider>/
connectd add --custom <id>         # a new connection from a template
```

| Flag | |
| --- | --- |
| `--id <id>` | The folder, which is the connection's id (default: the provider's name) |
| `--force` | Overwrite an existing `connection.ts` (run `diff` first) |
| `--registry <src>` | The catalog: a base URL or a folder (default `CONNECTD_REGISTRY`, else the connectd repo at this CLI's version) |
| `--custom <id>` | Create a custom connection instead of copying one |
| `--template <flow>` | With `--custom`: `oauth2` (default), `oidc`, `api-key`, `client-credentials`, `jwt-bearer`, `device` |

Writes `<dir>/<id>/connection.ts` and an empty `events.ts`, and appends the provider's env names to `.env`.

## `connectd diff`

```sh
connectd diff <id>
```

A unified diff between your copied `connection.ts` and the catalog's current version. Custom connections have no upstream.

## `connectd deploy`

| Flag | |
| --- | --- |
| `--env <name>` | The environment (default `production`). Reads `.env.<name>` and deploys its own Worker and database (`<name>-staging`) with its own keys. |
| `--env-file <f>` | Use this env file instead (default `.env.<env>`; in CI with `CI=true`, the shell environment). Only names the project reads are pushed. |
| `--name <name>` | Worker name (default: `cloudflare({ name })`, else the directory's name) |
| `--url <url>` | Public https origin on a custom domain (default: the workers.dev URL) |
| `--rotate <list>` | Comma-separated: `key` (adds `CONNECTD_KEY_V<n+1>`), `api-key`, `events`, `state`, `sessions` |
| `--new-keys` | Generate fresh runtime keys even though the index database exists without its Worker |
| `--dry-run` | Write `.connectd/deploy/` (entry, `wrangler.json`, migrations) and print the plan, with no Cloudflare calls |
| `--config <file>` | Config file (default `oc.config.ts`) |

Needs `wrangler` (`npm i -D wrangler`), logged in with `wrangler login` or with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set. In CI, `CONNECTD_API_KEY` comes from a CI secret, and deploy never prints one. See [deploying](/guides/deploying/).

## `connectd types`

Writes `.connectd/registry.d.ts` (the typed client's registry) and `.connectd/app.ts` (the listeners). `dev` and `deploy` write them too. Run it in CI before building your app.

## `connectd keys`

Prints a new `CONNECTD_API_KEY` and `CONNECTD_EVENTS_SECRET`, for CI secrets and your app's host.

## Environment variables

| Name | Read by | |
| --- | --- | --- |
| `CONNECTD_URL` | your app (SDK), `dev` | Where connectd runs |
| `CONNECTD_API_KEY` | your app, connectd | Bearer key for the API |
| `CONNECTD_EVENTS_SECRET` | your app, connectd | Event signing secret (`whsec_…`) |
| `CONNECTD_KEY_V<n>` | connectd | Encryption keys by version |
| `CONNECTD_STATE_KEY`, `CONNECTD_SESSIONS_KEY`, `CONNECTD_WEBHOOKS_KEY` | connectd | Signing keys |
| `CONNECTD_PUBLIC_URL` | connectd (deployed) | Its public URL. Set by deploy from `--url` or workers.dev. |
| `CONNECTD_REGISTRY` | `add`, `diff` | Catalog location |
| `APP_URL` | your config (by convention) | Your app's origin |
