# openConnect

OAuth connection management on Cloudflare Durable Objects — see [DECISIONS.md](./DECISIONS.md) for the architecture.

## Structure

- `apps/api` — the Manager Worker: `TeamDO`, `ConnectionDO`, D1 index, `/v1/*` (usage) and `/management/*` (dashboard) routes. Also serves `apps/dashboard`'s built assets.
- `apps/dashboard` — Clerk-authed SPA (Vite + TanStack Router, no SSR) for managing connectors, API keys, and connections.
- `packages/shared` — provider configs, crypto (AES-GCM + key versioning, HMAC state signing), and shared types.

## Setup

```bash
bun install
```

### Secrets (`apps/api`, via `wrangler secret put <NAME>`)

| Name | What |
|---|---|
| `MASTER_KEY_V1` | base64, 256-bit — `openssl rand -base64 32` |
| `STATE_SIGNING_KEY` | base64, 256-bit — same command |
| `CLERK_SECRET_KEY` | from the Clerk dashboard |
| `CLERK_JWT_KEY` | Clerk's JWKS PEM key (for networkless verification) |

### D1

Create the database and update `database_id` in `apps/api/wrangler.toml`:

```bash
cd apps/api
bunx wrangler d1 create openconnect
bun run db:migrate:local   # or db:migrate:remote
```

### Dashboard env

Copy `apps/dashboard/.env.example` to `.env.local` and fill in `VITE_CLERK_PUBLISHABLE_KEY`.

## Dev

```bash
bun run dev:api         # apps/api, wrangler dev
bun run dev:dashboard   # apps/dashboard, vite dev (proxies /management to :8787)
```

## Deploy

```bash
bun run --cwd apps/dashboard build   # dist/ consumed by apps/api's assets binding
bun run deploy:api
```

## Checks

```bash
bun run lint             # biome/ultracite, whole repo
bun --filter @openconnect/shared test
bun --filter @openconnect/api typecheck
bun --filter @openconnect/dashboard typecheck
```
