/**
 * The dashboard in a real Chromium (#32, #86), outside `bun run test`: Playwright isn't a dependency.
 * Run it where Playwright and a Chromium are installed:
 *
 *   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs bun packages/dashboard/e2e/chromium.ts
 *   (playwright-core with a system Chrome: also CHROME=/usr/bin/google-chrome)
 *
 * Serves the real runtime + dashboard() (memory driver) on localhost:8789 and checks: no CSP
 * violation or page error; a CLI link signs in and asks for an account; the account made with a
 * passkey (Chrome's virtual authenticator); keys made and shown once; a hostile id rendered as text;
 * sign out, then back in with the passkey.
 */
import { setup } from "../src/fake.ts";

const URL_ = "http://localhost:8789";
const t = await setup();
const evil = `<img src=x onerror="window.pwned=1">`;
await t.api(`/connections/keyed/${encodeURIComponent(evil)}/connect`, { apiKey: evil });
// The fake's clock is fixed: tokens are made at its time and checked at its time.
const server = Bun.serve({ port: 8789, hostname: "localhost", fetch: (req) => t.rt.fetch(new Request(req.url.replace(/^http:\/\/[^/]+/, URL_), req), t.w.platform) });

const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage();
const problems: string[] = [];
page.on("console", (m: { type(): string; text(): string }) => m.type() === "error" && problems.push(m.text()));
page.on("pageerror", (e: Error) => problems.push(String(e)));
page.on("response", (r: { status(): number; url(): string }) => r.status() >= 400 && console.log("HTTP", r.status(), r.url().slice(0, 120)));
const check = (name: string, ok: boolean, info?: unknown) => {
  console.log(ok ? "PASS" : "FAIL", name, info ?? "");
  if (!ok) process.exitCode = 1;
};
const text = () => page.textContent("body") as Promise<string>;
try {
  // A virtual platform authenticator (Touch ID-like), so passkeys work headless.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });

  await page.goto(`${URL_}/dashboard#login=${encodeURIComponent(await t.loginToken())}`);
  await page.waitForSelector("text=Create the first account");
  check("a CLI link signs in, asks for an account, and leaves the URL", (await page.evaluate(() => location.hash)) === "#/");
  await page.fill("#new-username", "ann");
  await page.click('button:text-is("Create account")');
  await page.waitForSelector('h1:text-is("Connections")');
  check("the account is made with a passkey", (await t.w.platform.db.passkeys.list("ann")).length === 1);

  await page.goto(`${URL_}/dashboard#/keys`);
  await page.fill("#key-name", "web");
  await page.click('button:has-text("Create")');
  await page.waitForSelector("text=Shown once");
  const shown = (await page.textContent("[role=dialog] pre")) ?? "";
  check("a new key is shown once, as env lines", /CONNECTD_URL=http:\/\/localhost:8789\nCONNECTD_API_KEY=ock_/.test(shown), shown.slice(0, 60));
  await page.click('button:text-is("Done")');
  check("its secret isn't on the page after", !(await text()).includes(shown.split("=").at(-1) ?? "x"));

  await page.goto(`${URL_}/dashboard#/c/keyed/${encodeURIComponent(evil)}`);
  await page.waitForSelector("text=Metadata, text=active", { timeout: 5000 }).catch(() => {});
  check("a hostile id is text", (await text()).includes(evil) && !(await page.evaluate(() => (window as { pwned?: number }).pwned)));

  await page.click('button:has-text("ann")');
  await page.click("text=Sign out");
  await page.waitForSelector("text=Sign in with a passkey");
  await page.click("text=Sign in with a passkey");
  // Back where it was (the connection's page), signed in as ann.
  await page.waitForSelector('button:has-text("ann")');
  check("back in with the passkey", (await text()).includes(evil));
  check("no CSP violation or page error", problems.length === 0, problems);
} finally {
  await browser.close();
  server.stop(true);
}
