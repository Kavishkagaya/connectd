import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseEnv } from "./env.ts";

/**
 * The GitHub App Manifest flow, in `connectd dev`: GitHub has no dynamic client registration
 * (RFC 7591), but it creates a whole GitHub App from a manifest. A page posts the manifest to
 * GitHub, the developer clicks "Create", GitHub redirects back with a code, and the code converts
 * (once, within an hour) into the app's id, slug, private key, OAuth client and webhook secret,
 * written to `.env` as the names the github-app connection reads. Nothing to copy by hand.
 *
 *   GET <public>/setup/github-app?t=<token>   the page (the token from the banner: dev may be on a public tunnel)
 *   GET <public>/setup/github-app/done        GitHub's redirect: convert, write .env (dev reloads), say what's next
 */

export const SETUP = "/setup/github-app";

/** The names `githubApp` reads, filled from GitHub's conversion. */
export const APP_ENV = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_WEBHOOK_SECRET", "GITHUB_APP_PRIVATE_KEY"] as const;

/** What `POST /app-manifests/{code}/conversions` answers (the fields used). */
export type Conversion = { id: number; slug: string; html_url: string; client_id: string; client_secret: string; webhook_secret: string | null; pem: string };

/**
 * The manifest for connection `def` on `pub`. Install comes back to `/callback` with an OAuth code
 * (`request_oauth_on_install`), which the github-app connection needs to check who installed it.
 * GitHub refuses webhook URLs it can't reach, so a local URL gets no webhook.
 */
export function manifest(pub: string, def: string, name: string) {
  const reachable = /^https:\/\//.test(pub) && !/^https:\/\/(localhost|127\.)/.test(pub);
  return {
    name,
    url: pub,
    ...(reachable ? { hook_attributes: { url: `${pub}/webhooks/${def}`, active: true } } : {}),
    redirect_url: `${pub}${SETUP}/done`,
    callback_urls: [`${pub}/callback`],
    request_oauth_on_install: true,
    public: false,
    // members: the callback's org-admin check. Add what your actions need in the app's settings later.
    default_permissions: { metadata: "read", members: "read" },
  };
}

/** A name GitHub will take (unique across GitHub, at most 34 characters). */
export function appName(dir: string, rand = crypto.getRandomValues(new Uint8Array(3))) {
  const base = basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 18) || "app";
  return `connectd-${base}-${[...rand].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The conversion's values as `.env` lines (the key double-quoted, newlines as `\n`, as dotenv and Next read it). */
export function envLines(c: Conversion): string {
  const v: Record<(typeof APP_ENV)[number], string> = {
    GITHUB_APP_ID: String(c.id),
    GITHUB_APP_SLUG: c.slug,
    GITHUB_APP_CLIENT_ID: c.client_id,
    GITHUB_APP_CLIENT_SECRET: c.client_secret,
    GITHUB_APP_WEBHOOK_SECRET: c.webhook_secret ?? "",
    GITHUB_APP_PRIVATE_KEY: `"${c.pem.trim().replace(/\r?\n/g, "\\n")}"`,
  };
  return `\n# GitHub App ${c.slug} (${c.html_url}), created by connectd dev\n${APP_ENV.map((k) => `${k}=${v[k]}`).join("\n")}\n`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.6rem 1.2rem;cursor:pointer}code{background:#8882;padding:0 .3em}input{font:inherit}</style>
<h1>${esc(title)}</h1>${body}`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com" } },
  );

export type SetupOptions = {
  dir: string;
  /** The public URL now (a tunnel's, or localhost). */
  publicUrl: () => string;
  /** The connection that reads GITHUB_APP_ID, if any. */
  def: () => string | undefined;
  /** The one-time token in the banner's link. */
  token: string;
  fetch?: typeof fetch;
  log?: (s: string) => void;
};

/** The setup routes: a Response for `/setup/github-app*`, else null. */
export function githubAppSetup(o: SetupOptions) {
  const f = o.fetch ?? fetch;
  const states = new Map<string, number>(); // state → expiry
  const envPath = join(o.dir, ".env");
  const have = () => (existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {});

  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    if (url.pathname !== SETUP && url.pathname !== `${SETUP}/done`) return null;
    if (req.method !== "GET") return new Response(null, { status: 405 });
    const def = o.def();
    if (!def) return page("No GitHub App connection", `<p>Add a connection that exports <code>githubApp</code> (from <code>@connectd/providers</code>) to a folder, then reload this page.</p>`, 404);
    const existing = have().GITHUB_APP_ID;
    const pub = o.publicUrl();

    if (url.pathname === SETUP) {
      if (url.searchParams.get("t") !== o.token) return page("Link expired", `<p>Open the setup link printed by <code>connectd dev</code>.</p>`, 403);
      if (existing) return page("Already set up", `<p><code>.env</code> already has <code>GITHUB_APP_ID=${esc(existing)}</code>. Delete the <code>GITHUB_APP_*</code> lines to create another app.</p>`, 409);
      const state = crypto.randomUUID();
      states.set(state, Date.now() + 3_600_000);
      const org = url.searchParams.get("org");
      const owner = org && /^[A-Za-z0-9-]{1,39}$/.test(org) ? `organizations/${org}/` : "";
      const m = manifest(pub, def, appName(o.dir));
      return page(
        "Create a GitHub App",
        `<p>connectd will create a private GitHub App named <code>${esc(m.name)}</code> on ${owner ? `the <b>${esc(org as string)}</b> organization` : "your GitHub account"}, and save its keys to <code>.env</code>. GitHub has no dynamic client registration, so this is how a client gets created without copying secrets.</p>
<p>Callback: <code>${esc(m.callback_urls[0] as string)}</code><br>Webhooks: ${m.hook_attributes ? `<code>${esc(m.hook_attributes.url)}</code>` : "off (needs a public https URL: run <code>connectd dev --tunnel</code>)"}</p>
<form method="post" action="https://github.com/${owner}settings/apps/new?state=${encodeURIComponent(state)}">
<input type="hidden" name="manifest" value="${esc(JSON.stringify(m))}">
<button type="submit">Create GitHub App on GitHub</button></form>
<p><small>For an organization: <code>?org=&lt;name&gt;</code> on this page's URL.</small></p>`,
      );
    }

    // GitHub's redirect.
    const state = url.searchParams.get("state") ?? "";
    const exp = states.get(state);
    states.delete(state);
    if (!exp || exp < Date.now()) return page("Setup expired", `<p>Start again from the link <code>connectd dev</code> printed.</p>`, 400);
    if (existing) return page("Already set up", `<p><code>.env</code> already has a GitHub App.</p>`, 409);
    const code = url.searchParams.get("code") ?? "";
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) return page("No code", `<p>GitHub didn't send a code back.</p>`, 400);
    const res = await f(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "user-agent": "connectd" },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      o.log?.(`github app manifest conversion failed: ${res.status} ${text.slice(0, 300)}`);
      return page("GitHub refused", `<p>Converting the code failed (${res.status}). Codes work once, within an hour: start again.</p>`, 502);
    }
    const c = (await res.json()) as Conversion;
    const before = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    writeFileSync(envPath, before + (before && !before.endsWith("\n") ? "\n" : "") + envLines(c), { mode: 0o600 });
    o.log?.(`created GitHub App ${c.slug} (${c.html_url}); wrote ${APP_ENV.join(", ")} to .env`);
    return page(
      "GitHub App created",
      `<p><a href="${esc(c.html_url)}">${esc(c.slug)}</a> is saved to <code>.env</code>, and connectd dev has reloaded with it.</p>
<p>Next: connect it from your app (<code>/api/connectd/connect/${esc(def)}</code>), which installs the app on your account or an org you administer.</p>`,
    );
  };
}
