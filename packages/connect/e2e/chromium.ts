/**
 * One end-to-end check in a real Chromium (#29), outside `bun run test`: Playwright isn't a
 * dependency. Run it where Playwright and a Chromium are installed:
 *
 *   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs bun packages/connect/e2e/chromium.ts
 *
 * Two sites (app on 127.0.0.1:5173, served with `Referrer-Policy: no-referrer`; runtime on
 * localhost:8788) and a fake provider page: popup (token given, and fetched after the click), a
 * provider page with COOP `same-origin` (cuts the opener), a popup the user closes, the API-key
 * form, redirect mode, and a ticket minted outside a browser that a victim opens.
 */
import { apiKey, defineConnection, oauth2 } from "@connectd/connections";
import { fakeOAuth } from "@connectd/connections/testing";
import { importHmacKey, importKeys } from "@connectd/kernel";
import { memory } from "@connectd/kernel/memory";
import { runtime, sessions } from "@connectd/runtime";

const RT = "http://localhost:8788",
  APP = "http://127.0.0.1:5173";
const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
const example = defineConnection({
  id: "example",
  auth: oauth2<{ clientId: string }>({ authorizeUrl: `${RT}/fake/authorize`, tokenUrl: "https://example.test/token" }),
});
// A provider whose consent page cuts the opener (COOP), like some identity providers.
const coopy = defineConnection({
  id: "coopy",
  auth: oauth2<{ clientId: string }>({ authorizeUrl: `${RT}/fake/authorize?coop=1`, tokenUrl: "https://example.test/token" }),
});
const keyed = defineConnection({ id: "keyed", auth: apiKey(["apiKey"]) });
const p = fakeOAuth({
  tokenUrl: "https://example.test/token",
  issue: (n) => ({ access_token: `a${n}` }),
  error: () => ({ status: 400, body: { error: "invalid_grant" } }),
});
const settings = {
  keys: await importKeys({ 1: key(1) }, 1),
  stateKey: await importHmacKey(key(9)),
  apiKey: "secret",
  redirectUri: `${RT}/callback`,
  config: { example: { clientId: "cid" }, coopy: { clientId: "cid" }, keyed: null },
  fetch: p.fetch,
  sessions: { key: await importHmacKey(key(5)), origins: [APP] },
};
const rt = runtime({ definitions: { example, coopy, keyed }, settings: async () => settings, extensions: [sessions()] });
const w = memory(rt.program, { now: Date.now() });
const rtServer = Bun.serve({
  port: 8788,
  hostname: "localhost",
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/fake/authorize") {
      const b = p.approve(req.url);
      return new Response(`<p>Provider consent</p><a id=ok href="${RT}/callback?code=${b.code}&state=${encodeURIComponent(b.state)}">Allow</a>`, {
        headers: { "content-type": "text/html", ...(u.searchParams.get("coop") ? { "cross-origin-opener-policy": "same-origin" } : {}) },
      });
    }
    return rt.fetch(req, w.call);
  },
});
const bundle = await Bun.build({ entrypoints: [`${import.meta.dir}/page.ts`], target: "browser" });
const js = await bundle.outputs[0]!.text();
const appServer = Bun.serve({
  port: 5173,
  hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/page.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
    if (u.pathname === "/token") {
      const q = u.searchParams;
      const args = q.get("return") ? { returnUrl: `${APP}/back?def=${q.get("def")}&id=${q.get("id")}` } : { origin: APP };
      const r = await rt.fetch(
        new Request(`${RT}/connections/${q.get("def")}/${q.get("id")}/session`, {
          method: "POST",
          headers: { authorization: "Bearer secret" },
          body: JSON.stringify(args),
        }),
        w.call,
      );
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
    }
    return new Response(
      `<!doctype html><button id=popup>popup</button><button id=lazy>lazy</button><button id=coop>coop</button><button id=fresh>fresh</button><button id=redir>redirect</button><div id=ui></div><pre id=out></pre><script type=module src=/page.js></script>`,
      { headers: { "content-type": "text/html", "referrer-policy": "no-referrer" } },
    );
  },
});
const state = async (def: string, id: string) =>
  (await (await rt.fetch(new Request(`${RT}/connections/${def}/${id}`, { headers: { authorization: "Bearer secret" } }), w.call)).json()).state;

const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m: { text(): string }) => console.log("console:", m.text()));
const check = (name: string, ok: boolean, info?: unknown) => {
  console.log(ok ? "PASS" : "FAIL", name, info ?? "");
  if (!ok) process.exitCode = 1;
};
try {
  await page.goto(APP);
  await page.waitForSelector("#ui button");
  for (const id of ["popup", "lazy"]) {
    const [popup] = await Promise.all([page.waitForEvent("popup"), page.click(`#${id}`)]);
    await popup.waitForSelector("#ok");
    await popup.click("#ok");
    await page.waitForFunction((id: string) => document.getElementById("out")!.textContent!.startsWith(id + ":"), id, { timeout: 10000 });
    const out = await page.textContent("#out");
    check(`${id} postMessage`, out === `${id}:{"status":"connected"}`, out);
    check(
      `${id} popup closed itself`,
      popup.isClosed() ||
        (await popup.waitForEvent("close", { timeout: 3000 }).then(
          () => true,
          () => false,
        )),
    );
  }
  check("popup connection active", (await state("example", "p1")) === "active");
  // closed by the user
  const [popup2] = await Promise.all([page.waitForEvent("popup"), page.click("#fresh")]);
  await popup2.waitForSelector("#ok");
  await Bun.sleep(6_000); // a user who looked at the provider page, then cancelled (a close in the first 5 s reads as COOP)
  await popup2.close();
  await page.waitForFunction(() => document.getElementById("out")!.textContent!.includes("closed"), null, { timeout: 15000 });
  check("closed detected", (await page.textContent("#out")) === 'fresh:{"status":"closed"}');
  // API-key form
  await page.fill("#ui input[name=apiKey]", "sk-123");
  await page.click("#ui button");
  await page.waitForFunction(() => document.getElementById("out")!.textContent!.startsWith("form:"));
  check(
    "form",
    (await page.textContent("#out")) === 'form:{"status":"connected"}' && (await state("keyed", "k1")) === "active",
    await page.textContent("#out"),
  );
  // A provider page with COOP same-origin cuts the opener: Chromium reports the popup closed once it
  // navigates there. connect() takes an early close for that and keeps waiting; the popup goes on to
  // the return URL, where resume() confirms and tells the opener on a BroadcastChannel.
  const [cp] = await Promise.all([page.waitForEvent("popup"), page.click("#coop")]);
  await cp.waitForSelector("#ok");
  await Bun.sleep(12_000); // a slow login: longer than any fixed poll after `closed`
  await cp.click("#ok");
  await page.waitForFunction(() => document.getElementById("out")!.textContent!.startsWith("coop:"), null, { timeout: 10000 });
  const coopOut = await page.textContent("#out");
  check("coop: a 12 s login after the popup read as closed, the opener still gets connected", coopOut === 'coop:{"status":"connected"}', coopOut);
  let coopState = "";
  for (let i = 0; i < 50 && coopState !== "active"; i++) {
    coopState = await state("coopy", "c1");
    await Bun.sleep(100);
  }
  check("coop: completed on the return URL in the popup", coopState === "active", coopState);
  // redirect mode
  await page.click("#redir");
  await page.waitForSelector("#ok");
  await page.click("#ok");
  await page.waitForURL(/\/back\?def=example&id=r1/);
  await page.waitForFunction(() => document.getElementById("out")!.textContent!.startsWith("redirect:"));
  check(
    "redirect",
    (await page.textContent("#out")) === 'redirect:{"status":"connected"}' && (await state("example", "r1")) === "active",
    await page.textContent("#out"),
  );
  check("redirect: the outcome is gone from the address bar", page.url() === `${APP}/back?def=example&id=r1`, page.url());
  await page.reload();
  await page.waitForSelector("#ui button");
  check("redirect: a reload does nothing", (await page.textContent("#out")) === "", await page.textContent("#out"));
  // Login CSRF: the attacker (user x1) mints a ticket outside a browser, forging Origin, and sends the
  // link to a victim logged in to the app as v1. The victim's browser does the provider login; the
  // completion lands on the victim's app page, whose session is v1's: it never activates x1.
  const t = await (await fetch(`${APP}/token?def=example&id=x1&return=1`)).json();
  const tic = await rt.fetch(
    new Request(`${RT}/session/authorize`, {
      method: "POST",
      headers: { origin: APP, authorization: `Bearer ${t.token}` },
      body: JSON.stringify({ mode: "redirect" }),
    }),
    w.call,
  );
  const ticket = ((await tic.json()) as { ticket: string }).ticket;
  const victim = await (await browser.newContext()).newPage();
  await victim.goto(APP);
  await victim.evaluate(() => localStorage.setItem("user", "v1"));
  await victim.goto(`${RT}/session/authorize?ticket=${encodeURIComponent(ticket)}`);
  await victim.click("#ok");
  await victim.waitForURL(/#connectd=authorized&definition=example&id=x1&completion=/);
  await victim.waitForSelector("#ui button"); // the page script ran (resume() first)
  const vout = await victim.textContent("#out");
  // resume() ignores an outcome for another connection than its session's: nothing confirmed, nothing shown.
  check("victim's page doesn't confirm the attacker's flow", vout === "" && (await state("example", "x1")) === "pending", vout);
} finally {
  await browser.close();
  rtServer.stop();
  appServer.stop();
}
