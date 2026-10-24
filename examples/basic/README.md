# examples/basic

A user project: `oc.config.ts`, and one folder per connection in `src/oc/` (`connection.ts`, `actions/`, and `events.ts` for your app).

## Dev

```sh
cp .env.example .env      # one file for your app and connectd
bun run dev               # connectd dev; only the names the connections read reach the runtime
```

## Your app

Your app talks to connectd through one client and one route. `connectd dev` (and `connectd types`)
writes `.connectd/app.ts` (the folders' `events.ts`) and `.connectd/registry.d.ts` (the types);
run `connectd types` before building the app in CI.

```ts
// lib/oc.ts: CONNECTD_URL, CONNECTD_API_KEY and CONNECTD_EVENTS_SECRET come from the environment.
import { connectd } from "@connectd/sdk";
import { listeners } from "../.connectd/app";
export const oc = connectd({ user: async (req) => (await getSession(req))?.userId ?? null, listeners });

// app/api/connectd/[...path]/route.ts (Next.js; any framework with Request => Response works)
import { oc } from "@/lib/oc";
export const { GET, POST } = oc.routes;
```

- A link to `/api/connectd/connect/github?return=/settings` connects the signed-in user's GitHub
  (connection id = the user's id; `&account=work` gives `<user>:work`, a second account), and comes
  back to `/settings?connectd=connected` (or `?connectd=error&code=...`).
- Point `events.url` in `oc.config.ts` at `<your app>/api/connectd/events`: events go to the folders'
  `listen()` handlers. Your app's origin must be in `sessions.origins`.
- Everything else: `oc.connection("github", userId).actions.profile()`, `.fetch("/user")`, `.status()`.

## Deploy by hand

```sh
cp .env.production.example .env.production
bun run deploy            # connectd deploy: prints the secrets it sends (names only), then your app's env:
                          #   CONNECTD_URL=https://basic.<you>.workers.dev
                          #   CONNECTD_API_KEY=oc_...   (shown once)
```

## Deploy from CI (GitHub Actions)

In CI, deploy reads the shell environment (your CI secrets), and the API key comes from a secret too:
it never generates or prints one there. Make the two values that are yours once, with
`bunx connectd keys`, and put them in the repository's secrets and in your app's host, next to
the provider credentials and a Cloudflare API token.

```yaml
# .github/workflows/connectd.yml
name: connectd
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bunx connectd deploy --url ${{ vars.CONNECTD_URL }}
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CONNECTD_API_KEY: ${{ secrets.CONNECTD_API_KEY }}
          CONNECTD_EVENTS_SECRET: ${{ secrets.CONNECTD_EVENTS_SECRET }}
          GITHUB_CLIENT_ID: ${{ secrets.OAUTH_GITHUB_CLIENT_ID }}
          GITHUB_CLIENT_SECRET: ${{ secrets.OAUTH_GITHUB_CLIENT_SECRET }}
```

`--url` (or `cloudflare({ url })` in `oc.config.ts`) is needed because CI has no `.connectd/deploy/state.json`
from the first deploy. GitHub secret names can't start with `GITHUB_`, hence the `OAUTH_` prefix on
the secrets: the env names the connections read stay `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
