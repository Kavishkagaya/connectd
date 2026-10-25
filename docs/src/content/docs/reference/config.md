---
title: oc.config.ts
description: Every field of the project config.
sidebar:
  order: 4
---

```ts title="oc.config.ts"
import { defineConfig } from "@connectd/cli";
import { cloudflare } from "@connectd/cloudflare";

export default defineConfig((env) => ({
  dir: "src/oc",
  target: cloudflare({ name: "my-app" }),
  events: { url: `${env.APP_URL}/api/connectd/events` },
  sessions: { origins: [env.APP_URL as string] },
}));
```

`defineConfig` takes an object, or a function of the environment. In dev, `env` is `.env` plus the process env. Deployed, it's the Worker's vars and secrets. Read names one at a time (`env.NAME`): only the names you read are sent to the Worker, and spreading or listing `env` throws.

The config is bundled **into the deployed Worker**, so keep it free of Node APIs.

| Field | Type | |
| --- | --- | --- |
| `dir` | `string` | The connection folders' parent, relative to the config. Default `src/oc`, else `oc`. |
| `target` | `Target` | Where `connectd deploy` goes: `cloudflare({ name?, url?, environments? })`. `dev` ignores it. |
| `events` | `{ url }` | Where events are POSTed, signed with `CONNECTD_EVENTS_SECRET`. Without it, no events, and webhooks are refused with `503`. |
| `sessions` | `{ origins: string[] }` | Exact origins (`https://app.example.com`) allowed to run the connect UI and be returned to. Needed for `oc.routes`. |
| `dashboard` | `boolean` | The dashboard at `/dashboard`. Default `true`. |
| `extensions` | `Extension[]` | Your [extensions](/extending/extensions/), added after the built-in ones |
| `definitions` | `Connection[]` | Connections listed here instead of in folders. Each needs an id: `connection("id")`. |
| `actions` | `{ [connectionId]: { [name]: action } }` | Actions for connections listed in `definitions` |
| `config` | `{ [definitionId]: unknown }` | Connector config for definitions that don't read their own with `.config((env) => …)` |

## `cloudflare(options)`

From `@connectd/cloudflare`:

| Option | |
| --- | --- |
| `name` | Worker name. Default: the project directory's. `--name` overrides it. |
| `url` | Public URL on a custom domain. Default: the workers.dev URL. `--url` overrides it. |
| `environments` | `{ [env]: { name?, url? } }` per `--env`. Defaults: `<name>-<env>` and its workers.dev URL. |

## Built-in extensions

The CLI always adds these, and each stays dormant until its setting is present:

| Extension | Active when |
| --- | --- |
| proxy | A definition has `.api()` |
| events | `events` is set |
| webhooks | A definition has `.webhooks()` (registration needs the public URL) |
| sessions | `sessions` is set |
| directory (index) | Always: memory in dev, D1 deployed |
| dashboard | `dashboard` isn't `false` |
| actions | Any folder has `actions/` |
