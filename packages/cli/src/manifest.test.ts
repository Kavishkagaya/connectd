import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "./env.ts";
import { appName, githubAppSetup, manifest, SETUP } from "./manifest.ts";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\nBBBB\n-----END RSA PRIVATE KEY-----\n";

test("manifest: callback and install OAuth; webhooks only on a public https URL", () => {
  const local = manifest("http://localhost:8787", "github-app", "n");
  expect(local).toMatchObject({ redirect_url: `http://localhost:8787${SETUP}/done`, callback_urls: ["http://localhost:8787/callback"], request_oauth_on_install: true, public: false });
  expect("hook_attributes" in local).toBe(false);
  expect(manifest("https://x.trycloudflare.com", "gh", "n").hook_attributes).toEqual({ url: "https://x.trycloudflare.com/webhooks/gh", active: true });
  const name = appName("/a/My Next.js App!", new Uint8Array([1, 2, 255]));
  expect(name).toBe("connectd-my-next-js-app-0102ff");
  expect(appName("/x/".padEnd(80, "a")).length).toBeLessThanOrEqual(34);
});

test("setup: token-gated page, one-time state, conversion written to .env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "connectd-manifest-"));
  writeFileSync(join(dir, ".env"), "APP=1");
  const calls: string[] = [];
  const fake = (async (u: string) => {
    calls.push(u);
    return Response.json({ id: 42, slug: "connectd-x", html_url: "https://github.com/apps/connectd-x", client_id: "Iv1.c", client_secret: "s3", webhook_secret: "wh", pem: PEM });
  }) as unknown as typeof fetch;
  const setup = githubAppSetup({ dir, token: "tok", publicUrl: () => "http://localhost:1", def: () => "github-app", fetch: fake });
  const get = (p: string) => setup(new Request(`http://localhost:1${p}`)) as Promise<Response>;

  expect(await setup(new Request("http://localhost:1/connections"))).toBeNull();
  expect((await get(`${SETUP}?t=nope`)).status).toBe(403);
  const html = await (await get(`${SETUP}?t=tok`)).text();
  expect(html).toContain('action="https://github.com/settings/apps/new?state=');
  expect(await (await get(`${SETUP}?t=tok&org=acme`)).text()).toContain("https://github.com/organizations/acme/settings/apps/new");
  const state = /state=([0-9a-f-]+)/.exec(html)?.[1] as string;

  expect((await get(`${SETUP}/done?state=wrong&code=abc`)).status).toBe(400);
  expect(calls).toEqual([]);
  expect((await get(`${SETUP}/done?state=${state}&code=abc`)).status).toBe(200);
  expect(calls).toEqual(["https://api.github.com/app-manifests/abc/conversions"]);
  const env = parseEnv(readFileSync(join(dir, ".env"), "utf8"));
  expect(env).toMatchObject({ APP: "1", GITHUB_APP_ID: "42", GITHUB_APP_SLUG: "connectd-x", GITHUB_APP_CLIENT_ID: "Iv1.c", GITHUB_APP_CLIENT_SECRET: "s3", GITHUB_APP_WEBHOOK_SECRET: "wh" });
  expect(env.GITHUB_APP_PRIVATE_KEY).toBe(PEM.trim());

  // The state was single use, and a configured app isn't replaced.
  expect((await get(`${SETUP}/done?state=${state}&code=abc`)).status).toBe(400);
  expect((await get(`${SETUP}?t=tok`)).status).toBe(409);
});
