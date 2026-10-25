---
title: HTTP API
description: Every route the runtime serves, who may call it, and the error format.
sidebar:
  order: 3
---

The SDK wraps all of this. You need the raw API only from a language without an SDK, or for debugging with `curl`.

Routes are keyed by their first path segment. All of them need `Authorization: Bearer <CONNECTD_API_KEY>` **except** the ones marked public.

## Connections

| Method | Path | |
| --- | --- | --- |
| `GET` | `/connections?def=&state=&q=&external=key:value&cursor=&limit=` | List from the index: `{ connections: Row[], cursor }` |
| `GET` | `/connections/:def/:id` | Status: `{ state, reason?, metadata }` |
| `POST` | `/connections/:def/:id/connect` | Start an authorization. Body: input strings (`{ scope }`, API-key fields, `{ subject }`). → `{ url, device? }` |
| `POST` | `/connections/:def/:id/token` | The credential, refreshed if due |
| `POST` | `/connections/:def/:id/revoke` | Body: `{ reason? }`. → status |
| `POST` | `/connections/:def/:id/session` | A browser session token. Body: `{ origin?, returnUrl?, ttlMs?, hosted?, next?, confirm? }` |
| `POST` | `/connections/:def/:id/actions/:name` | Run an action. Body: its input. |
| `POST` | `/connections/:def/:id/:method` | Any extension method: `events.status`, `events.flush`, `events.redeliver`, `webhooks.subscribe`, `webhooks.list`, `webhooks.unsubscribe`, `webhooks.status`, `webhooks.endpoint`, `actions.status`, `index.sync` |

Bodies are JSON. Internal methods (`kernel.*`, `proxy.prepare`, `webhooks.receive`, …) answer `404`.

```sh
curl -H "Authorization: Bearer $CONNECTD_API_KEY" "$CONNECTD_URL/connections/github/alice"
```

## Proxy

| Method | Path | |
| --- | --- | --- |
| any | `/proxy/:def/:id/<path>?<query>` | Forwarded to `<baseUrl>/<path>?<query>` with the connection's credential |

The request and response bodies stream through. Your `authorization` and `host` headers aren't forwarded. The provider's response comes back as-is, and only connectd's own refusals carry `connectd-error`.

## Public routes

| Method | Path | Called by |
| --- | --- | --- |
| `GET` | `/callback?state=&code=` | The provider, after consent. `state` routes to the instance. |
| `POST` | `/webhooks/:def/:id` | The provider: a per-connection webhook |
| `POST` | `/webhooks/:def` | The provider: an app-wide webhook, routed by external id |
| `GET` | `/session` | The browser (session token, CORS): what to render |
| `POST` | `/session/connect` | The browser: submit an API-key form, `{ fields }` |
| `POST` | `/session/authorize` | The browser: `{ mode, nonce }` → `{ ticket }` (single use, 60 s) |
| `GET` | `/session/authorize?ticket=` | Popup or page navigation: sets the binding cookie, then redirects to the provider |
| `POST` | `/session/complete` | The browser: `{ completion }` → activates |
| `GET` | `/connect?token=` | The hosted connect page (`link()`) |
| `GET` | `/dashboard` | The dashboard page. Its `/dashboard/api/*` calls need the API key. |

## Errors

Every error the runtime answers is JSON, with a `connectd-error: <code>` header:

```json
{ "error": { "code": "not_active", "status": 409, "message": "connection is reauth_required (invalid_grant)", "state": "reauth_required", "reason": "invalid_grant" } }
```

| Code | Status | Meaning |
| --- | --- | --- |
| `bad_request` | 400 | Bad input. Action input failures include `issues`. |
| `unauthorized` | 401 | Missing or wrong API key, or a bad webhook signature |
| `forbidden` | 403 | Not allowed from here (origin, user, session scope) |
| `not_found` | 404 | No such route, definition, connection or method |
| `method_not_allowed` | 405 | |
| `not_active` | 409 | The connection isn't active. Includes `state` and `reason`. |
| `illegal_transition` | 409 | A state change the lifecycle doesn't allow |
| `gone` | 410 | |
| `rate_limited` | 429 | Includes `retryAfterMs` and a `Retry-After` header. The provider wasn't called. |
| `error` | 500 | Definition code or an internal error. State is untouched. |
| `bad_credential` | 500 | A static credential lacks the field `.api({ key })` names |
| `upstream_error` | 502 | Network failure reaching the provider, or a provider 5xx during OAuth |
| `not_configured` | 503 | Missing connector config or a deployment setting (events, webhooks) |
| `delivery_failed` | 503 | An app-wide webhook didn't reach every connection, so the provider should retry |
| `upstream_timeout` | 504 | No response headers from the provider in time |
| `session_expired`, `session_used`, `bad_ticket` | 401 | Browser session problems |
| `session_mismatch` | 403 | The callback came back in a different browser than the one that started the flow |

OAuth errors from the provider pass through with the provider's code (`access_denied`, `invalid_grant`, …) and status `400`.
