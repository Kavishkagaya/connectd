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
| [`init`](#connectd-init) | Sets up dev in your app: the root key, `CONNECTD_URL` and `APP_URL` in `.env`, `oc.config.ts`, `lib/oc.ts`, the route |
| [`dev`](#connectd-dev) | Runs the runtime locally: real clock, state and keys in `.connectd/`, reloads on save |
| [`add`](#connectd-add) | Copies a provider into the project, or creates a custom one |
| [`diff`](#connectd-diff) | Shows what changed upstream in a copied provider |
| [`deploy`](#connectd-deploy) | Deploys to your Cloudflare account, through wrangler |
| [`types`](#connectd-types) | Writes `.connectd/registry.d.ts` and `.connectd/app.ts` |
| [`keys`](#connectd-keys) | A deployment's API keys and events secrets: list, create, roll, revoke |
| [`dashboard`](#connectd-dashboard) | Opens a deployment's dashboard, signed in |
| `help` | Prints the help text |

## `connectd init`

Writes only what's missing, and never overwrites:

- `.env`: `APP_URL`, `CONNECTD_URL`, and the project's root key, `CONNECTD_ROOT_KEY`. It's made owner-only (`0600`).
- `.gitignore`: adds `.env`. It refuses to write the root key into a `.env` that git tracks.
- `oc.config.ts`, `<src>/lib/oc.ts`, and for Next.js (App Router) `app/api/connectd/[...path]/route.ts`.
- The deploy target, for a new `oc.config.ts`: asked in a terminal (or `--target`). For Cloudflare it installs `@kavishkagaya/connectd-cloudflare` and `wrangler` as dev dependencies, with your lockfile's package manager (else the one that ran it, else npm), and writes `target: cloudflare({ name })`. Already installed: used without asking.

| Flag | |
| --- | --- |
| `--port <n>` | Where `connectd dev` will run (default 8787), written as `CONNECTD_URL` |
| `--app-url <url>` | Your app's origin (default `APP_URL` from `.env`, else `http://localhost:3000`) |
| `--target <t>` | Where it deploys: `cloudflare`, or `none` to decide later (default: asked in a terminal; none in CI) |
| `--skip-install` | Write the target into the config without installing its packages |

The root key is the project's for good: every environment's keys derive from it ([security](/concepts/security/#keys)), and it never changes. init never replaces one, so a teammate copies theirs into `.env` before running it. Keep a copy in your password manager, and give CI the same one as a secret.

## `connectd dev`

| Flag | |
| --- | --- |
| `--port <n>` | Port (default: `CONNECTD_URL`'s in `.env`, else 8787; `0` picks a free one) |
| `--config <file>` | Config file (default `oc.config.ts`) |
| `--tunnel` | Expose it on a public https URL with a cloudflared quick tunnel (Slack needs https) |
| `--url <url>` | The public URL of a tunnel you run yourself. Callback and webhook URLs use it. |
| `--reset` | Start from empty state. Keys and dashboard accounts stay (they're in `.connectd/dev.db`). |

dev derives its keys from the root key, keeps API keys and accounts in SQLite (`.connectd/dev.db`), and writes your app's `CONNECTD_API_KEY` (and `CONNECTD_EVENTS_SECRET` when events are on) into `.env` when they're missing. See [local dev](/guides/local-dev/).

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
| `--env <name>` | The environment (default `production`). Reads `.env.<name>` and deploys its own Worker and database (`<name>-staging`) with its own keys, derived from the root key. |
| `--env-file <f>` | Use this env file instead (default `.env.<env>`; in CI with `CI=true`, the shell environment). Only names the project reads are pushed. |
| `--name <name>` | Worker name (default: `cloudflare({ name })`, else the directory's name) |
| `--url <url>` | Public https origin on a custom domain (default: the workers.dev URL) |
| `--rotate key` | Add an encryption key version (`CONNECTD_KEY_V<n+1>`); older ones stay, to open what they sealed |
| `--dry-run` | Write `.connectd/deploy/` (entry, `wrangler.json`, migrations) and print the plan, with no Cloudflare calls |
| `--config <file>` | Config file (default `oc.config.ts`) |

Needs `wrangler` (`npm i -D wrangler`), logged in with `wrangler login` or with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set, and the root key (`.env`, the shell, or in CI a secret). The first deploy of an environment makes your app's API key (and events secret) and prints them once. See [deploying](/guides/deploying/).

## `connectd types`

Writes `.connectd/registry.d.ts` (the typed client's registry) and `.connectd/app.ts` (the listeners). `dev` and `deploy` write them too. Run it in CI before building your app.

## `connectd keys`

```sh
connectd keys                          # list (dev, unless --env or --url)
connectd keys create <name>            # a new API key, shown once
connectd keys create <name> --events   # a new events signing secret
connectd keys roll <id|name> --grace 24h
connectd keys revoke <id|name>
```

| Flag | |
| --- | --- |
| `--env <name>` | Which deployment: dev (default; `CONNECTD_URL` in `.env`), or an environment at the URL its last deploy from here used |
| `--url <url>` | The deployment's URL instead. With `CONNECTD_ROOT_KEY` in the shell, this works outside the project. |
| `--events` | `create`: an events secret (`CONNECTD_EVENTS_SECRET`) instead of an API key |
| `--grace <time>` | `roll`: how long the old secret keeps working (`0`, `30m`, `24h`, `7d`; default `0`) |

Keys live in the deployment's database, so the dashboard shows and manages the same ones. A secret is shown once; in dev, `create` and `roll` also write it into `.env`. The CLI signs each request with the deployment's admin key, derived from the root key: the root key itself is never sent.

## `connectd dashboard`

```sh
connectd dashboard                     # dev
connectd dashboard --env production    # a deployment
```

Opens the dashboard signed in, with a link signed by the admin key that works once, within 5 minutes. `--print` prints it instead (over SSH, say). The dashboard then offers to make an account, with a passkey or a password, so later sign-ins need no CLI. `--env` and `--url` work as for `keys`.

## Environment variables

| Name | Read by | |
| --- | --- | --- |
| `CONNECTD_ROOT_KEY` | the CLI (`dev`, `deploy`, `keys`, `dashboard`) | The project's root key. Never in a deployment. |
| `CONNECTD_URL` | your app (SDK), `dev` | Where connectd runs |
| `CONNECTD_API_KEY` | your app | Bearer key for the API (`connectd keys create`) |
| `CONNECTD_EVENTS_SECRET` | your app | Event signing secret (`whsec_…`, `connectd keys create --events`) |
| `CONNECTD_KEY_V<n>` | connectd | Encryption keys by version, derived |
| `CONNECTD_STATE_KEY`, `CONNECTD_SESSIONS_KEY`, `CONNECTD_WEBHOOKS_KEY`, `CONNECTD_ADMIN_KEY` | connectd | Signing keys, derived |
| `CONNECTD_PUBLIC_URL` | connectd (deployed) | Its public URL. Set by deploy from `--url` or workers.dev. |
| `CONNECTD_REGISTRY` | `add`, `diff` | Catalog location |
| `APP_URL` | your config (by convention) | Your app's origin |
