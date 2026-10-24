# examples/nextjs

A Next.js app with a GitHub connection, end to end: a "Connect GitHub" link, the connected
account, and a call through the connection (the user's repositories).

## Run it

1. Create a GitHub OAuth app (github.com/settings/developers) with the callback URL
   `http://localhost:8787/callback`.
2. Set up `.env` and start both servers, in two terminals:

```sh
bun install                 # at the repo root
cd examples/nextjs
cp .env.example .env        # fill GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET
bun run dev:connectd        # connectd dev on :8787
bun run dev                 # next dev on :3000
```

On its first run, `connectd dev` appends `CONNECTD_URL`, `CONNECTD_API_KEY` and
`CONNECTD_EVENTS_SECRET` to `.env`, which Next reads too: nothing to copy. Start `connectd dev`
first, or restart `next dev` once those lines are there.

3. Open http://localhost:3000, sign in with any name, click **Connect GitHub**, and approve.
   The dashboard is at http://localhost:8787/dashboard (the API key is in `.env`).

`APP_URL` in `.env` is the app's origin; `oc.config.ts` builds `sessions.origins` and `events.url`
from it, so it's written once.

## Files

- `src/oc/github/connection.ts`: the `github` provider; `events.ts`: its `listen()` handlers.
- `src/lib/oc.ts`: the client, with the demo's cookie as the signed-in user.
- `src/app/api/connectd/[...path]/route.ts`: `oc.routes` (connect, return, events).
- `src/app/page.tsx`: status, connect, and a call through the connection (`/user/repos`).
