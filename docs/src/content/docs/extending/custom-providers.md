---
title: Custom providers
description: Write a connection for any API. Start from a template, handle the provider's quirks, and test it against a fake.
sidebar:
  order: 1
---

Any API the catalog doesn't cover is one file away. Custom connections are exactly the same as catalog ones: a `connection()` builder in `src/oc/<id>/connection.ts`.

## Start from a template

```sh
npx connectd add --custom acme                        # OAuth 2.0 (the default template)
npx connectd add --custom acme --template oidc
npx connectd add --custom acme --template api-key
npx connectd add --custom acme --template client-credentials
npx connectd add --custom acme --template jwt-bearer
npx connectd add --custom acme --template device
```

This writes `src/oc/acme/connection.ts`, an empty `events.ts`, and the env names (`ACME_CLIENT_ID`, `ACME_CLIENT_SECRET`) in `.env`. `example.com` URLs mark what to fill in:

```ts title="src/oc/acme/connection.ts (oauth2 template, filled in)"
import { connection, type OAuth2Config } from "@connectd/connections";

export default connection()
  .config<OAuth2Config>((env) => ({ clientId: env("ACME_CLIENT_ID"), clientSecret: env("ACME_CLIENT_SECRET") }))
  .auth((f) =>
    f
      .oauth2({ authorizeUrl: "https://acme.com/oauth/authorize", tokenUrl: "https://acme.com/oauth/token" })
      .scopes("read"),
  )
  .api({ baseUrl: "https://api.acme.com/v1" })
  // Who the credential belongs to; a throw rejects it.
  .identity(async ({ api }) => {
    const res = await api.fetch("/me");
    if (!res.ok) throw new Error(`acme /me ${res.status}`);
    const me = (await res.json()) as { id: string | number };
    return { id: String(me.id) };
  })
  .external((me) => ({ id: me.id }));
```

Save it while `connectd dev` runs, and it reloads.

## A checklist for a new provider

Work through these with the provider's docs open:

1. **Endpoints and scopes.** Authorize URL, token URL, scope separator (`" "` or `","`).
2. **PKCE.** On by default. Turn it off only if the provider rejects it: `.pkce(false)`.
3. **Client authentication.** Does the token endpoint want HTTP Basic or form fields? `.clientAuth("basic" | "post")`.
4. **Refresh tokens.** Does the provider need an extra parameter to issue one (`access_type=offline`)? Use `.params({ … })`. Does it rotate them? (That's handled.) What error code means "dead"? Use `.deadRefreshToken("…")`.
5. **Odd token responses.** Is the token nested? Are errors returned with a `200`? Override `.callback()` and `.refresh()` and reshape the response.
6. **Revocation.** Is there an RFC 7009 endpoint (`revokeUrl`), or something custom (`.revoke()`)?
7. **The API.** Base URL, required headers (`user-agent`), and where the token goes (`key`).
8. **Rate limits.** Published limits go in `.limit()`, rate headers go in `.observe()`.
9. **Identity.** A cheap "who am I" call, and the stable id to index in `.external()`.
10. **Webhooks.** Signature scheme, per-connection or app-wide, and whether they expire.

## Real quirks, real fixes

Each catalog provider is a worked example, worth reading in the [registry](https://github.com/Kavishkagaya/connectd/tree/main/packages/providers/src):

| Provider | Quirk | Fix |
| --- | --- | --- |
| GitHub | Rejects API calls without `User-Agent` | `.api({ headers: { "user-agent": … } })` |
| GitHub | Dead refresh token is `bad_refresh_token` | `.deadRefreshToken("bad_refresh_token")` |
| GitHub | Revoke is `DELETE /applications/{id}/grant` | A `.revoke()` override |
| Slack | Comma-separated scopes, bot vs user scopes | `.scopeSeparator(",")`, `.params(c => ({ user_scope }))` |
| Slack | User token nested under `authed_user` | `.callback()` and `.refresh()` overrides that lift it |
| Slack | One webhook URL per app, routed by workspace | App-wide webhooks with `external: { key: "teamId" }` |
| Google | Refresh token only with `access_type=offline` + `prompt=consent` | `.params({ … })` |
| Google | Watch channels expire | `register` returns `expiresAt`, so connectd renews |
| GitHub App | Tokens minted per installation, not from the user | A custom `f.flow()` with `mints: true` and `data: { installationId }` |

## Testing

`@connectd/connections/testing` runs your connection on the in-memory driver against a fake authorization server. No network, and a clock you control:

```ts title="src/oc/acme/connection.test.ts"
import { expect, test } from "bun:test";   // or vitest
import type { OAuth2 } from "@connectd/connections";
import { fakeOAuth, harness } from "@connectd/connections/testing";
import acme from "./connection.ts";

test("acme: connect, refresh, dead refresh token", async () => {
  const p = fakeOAuth({
    tokenUrl: "https://acme.com/oauth/token",
    issue: (n) => ({ access_token: `at_${n}`, refresh_token: `r${n}`, expires_in: 3600 }),
    error: (code) => ({ status: 400, body: { error: code } }),
    route: (url) => (url === "https://api.acme.com/v1/me" ? Response.json({ id: 7 }) : new Response(null, { status: 404 })),
  });
  const { w, get, callback } = await harness(acme, { clientId: "id", clientSecret: "secret" }, p.fetch);
  const c = await get("conn:acme:alice");

  await callback(p.approve((await c.connect())!));     // the user approves
  expect(await c.metadata()).toEqual({ id: "7" });
  expect(((await c.token()) as OAuth2).accessToken).toBe("at_1");

  await w.advance(3_600_000);                           // an hour later: refreshed
  expect(((await c.token()) as OAuth2).accessToken).toBe("at_2");

  p.s.live.clear();                                     // the refresh token dies
  await expect(c.conn.refresh()).rejects.toMatchObject({ state: "reauth_required", reason: "invalid_grant" });
});
```

- `fakeOAuth` binds codes to the PKCE challenge, and refresh tokens are single-use (`r1`, `r2`, …), so rotation bugs show up. Pass `rotate: false` for providers that keep refresh tokens.
- `p.s.requests` records every request, for asserting on revoke calls and headers.
- `w.advance(ms)` jumps the clock once, and timers that are due fire.

## Share it

If the provider is useful to others, [add it to the catalog](/contributing/providers/).
