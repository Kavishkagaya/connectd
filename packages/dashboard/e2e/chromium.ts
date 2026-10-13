/**
 * The dashboard in a real Chromium (#32), outside `bun run test`: Playwright isn't a dependency.
 * Run it where Playwright and a Chromium are installed:
 *
 *   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs bun packages/dashboard/e2e/chromium.ts
 *
 * Serves the real runtime + dashboard() (memory driver) on localhost:8789 and checks: no CSP
 * violation or page error, sign in, the list and its filter, a hostile id rendered as text, the
 * connection page with a parked event, deliver now, redeliver, revoke, definitions, sign out.
 */
import { API_KEY, setup } from "../src/fake.ts";

const URL_ = "http://localhost:8789";
const t = await setup();
t.failEvents(503);
const evil = `<img src=x onerror="window.pwned=1">`;
for (const [id, key] of [
  ["alice", "acct_a"],
  ["bob", "acct_b"],
  [evil, evil],
] as const)
  await t.api(`/connections/keyed/${encodeURIComponent(id)}/connect`, { apiKey: key });
await t.w.advance(0); // the first deliveries fail: alice's outbox is parked
const server = Bun.serve({ port: 8789, hostname: "localhost", fetch: (req) => t.rt.fetch(req, t.w.call) });

const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const browser = await chromium.launch();
const page = await browser.newPage();
const problems: string[] = [];
page.on("console", (m: { type(): string; text(): string }) => m.type() === "error" && problems.push(m.text()));
page.on("pageerror", (e: Error) => problems.push(String(e)));
const check = (name: string, ok: boolean, info?: unknown) => {
  console.log(ok ? "PASS" : "FAIL", name, info ?? "");
  if (!ok) process.exitCode = 1;
};
const text = () => page.textContent("main") as Promise<string>;
try {
  await page.goto(`${URL_}/dashboard`);
  await page.fill("input[name=key]", "wrong");
  await page.click('button:text-is("Sign in")');
  await page.waitForSelector("text=Wrong API key.");
  check("wrong key refused", true);
  problems.length = 0; // its 401 is logged as a failed resource
  await page.fill("input[name=key]", API_KEY);
  await page.click('button:text-is("Sign in")');
  await page.waitForSelector("td >> text=alice");
  check("signed in: the list", (await text()).includes("account=acct_b"));
  check("the key is in sessionStorage only", (await page.evaluate(() => [sessionStorage.length, localStorage.length, document.cookie])).join() === "1,0,");
  check("a hostile id is text", (await page.evaluate(() => [document.querySelectorAll("main img").length, (window as { pwned?: number }).pwned ?? 0])).join() === "0,0");
  check("…and shown as is", (await text()).includes(evil));

  await page.fill("input[name=q]", "acct_b");
  await page.click('button:text-is("Filter")');
  await page.waitForFunction(() => location.hash === "#/?q=acct_b" && document.querySelectorAll("tbody tr").length === 1);
  check("filtered by external id", (await page.textContent("tbody")) !== null && (await page.textContent("tbody"))!.includes("bob"));

  await page.goto(`${URL_}/dashboard#/c/keyed/alice`);
  await page.waitForSelector("text=Last error");
  check("a reload keeps the tab signed in; the parked head and its error", (await text()).includes("HTTP 503"));
  t.failEvents(200);
  await page.click('button:text-is("Deliver now")');
  await page.waitForSelector("text=Delivery started");
  await t.w.advance(0);
  await page.click('button:text-is("Refresh")');
  await page.waitForSelector("text=Recent (newest first)");
  check("delivered now", (await text()).includes("Pending0"));
  const before = t.delivered.length;
  await page.click('button:text-is("Redeliver")');
  await page.waitForSelector("text=same webhook-id");
  await t.w.advance(0);
  check("redelivered: the same body", t.delivered.length === before + 1 && t.delivered.at(-1) === t.delivered.at(-2), t.delivered.length);
  await page.goto(`${URL_}/dashboard#/c/keyed/%2E%2E`);
  await page.waitForSelector("text=Not a connection address");
  check("the router refuses `..` as an id", true);
  await page.goto(`${URL_}/dashboard#/c/keyed/alice`);
  await page.waitForSelector('button:text-is("Revoke")');
  page.once("dialog", (d: { accept(): Promise<void> }) => d.accept());
  await page.click('button:text-is("Revoke")');
  await page.waitForSelector("text=Revoked.");
  check("revoked", (await text()).includes("Staterevoked"));

  await page.click('a:text-is("Definitions")');
  await page.waitForSelector("text=Callback URL");
  const defs = await text();
  check("definitions", defs.includes("https://oc.test/callback") && defs.includes("missing: not_configured"));

  await page.click('button:text-is("Sign out")');
  await page.waitForSelector("text=Sign in");
  check("signed out", (await page.evaluate(() => sessionStorage.length)) === 0);
  check("no CSP violation or page error", problems.length === 0, problems);
} finally {
  await browser.close();
  server.stop();
}
