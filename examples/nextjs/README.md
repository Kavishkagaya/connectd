# examples/nextjs

A Next.js app with a GitHub connection, end to end: a "Connect GitHub" button, the user's
installation, and the repositories it can see. GitHub is a GitHub App here, created for you from a
manifest (GitHub has no dynamic client registration, RFC 7591; the manifest flow is its equivalent).

## Run it

```sh
bun install               # at the repo root
cd examples/nextjs
bun run dev               # connectd dev -- next dev
```

`connectd dev -- next dev` starts the runtime on :8787 and Next on :3000 (`--app-port` to change it).
Next gets `CONNECTD_URL`, `CONNECTD_API_KEY`, `CONNECTD_EVENTS_SECRET`, `APP_URL` and `PORT` from it, so
there are no dev keys to copy. `oc.config.ts` reads `APP_URL` for `sessions.origins` and `events.url`.

1. Open the **github app** link `connectd dev` prints, click **Create GitHub App on GitHub**, and
   confirm on GitHub. connectd writes the `GITHUB_APP_*` lines to `.env` and reloads.
   (For an org: add `&org=<name>` to the link.)
2. Open http://localhost:3000, sign in with any name, and click **Connect GitHub**. GitHub asks
   where to install the app and to authorize it; you land back on the page with the connection active.
3. The dashboard is at http://localhost:8787/dashboard (the API key is in the banner).

Webhooks need a public https URL: `bun run dev -- --tunnel` doesn't work (the flags go to Next), so run
`bunx connectd dev --tunnel -- next dev` before creating the app, and the manifest includes the
webhook URL. The app itself stays on localhost.

## Files

- `src/oc/github/connection.ts`: the `githubApp` provider; `events.ts`: its `listen()` handlers.
- `src/lib/oc.ts`: the client, with the demo's cookie as the signed-in user.
- `src/app/api/connectd/[...path]/route.ts`: `oc.routes` (connect, return, events).
- `src/app/page.tsx`: status, connect, and a call through the connection (`/installation/repositories`).
