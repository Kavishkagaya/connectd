/**
 * One end-to-end check in a real Chromium (#29), outside `bun run test`: Playwright isn't a
 * dependency. Run it where Playwright and a Chromium are installed:
 *
 *   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs bun packages/connect/e2e/chromium.ts
 *
 * Two sites (app on 127.0.0.1:5173, runtime on localhost:8788) and a fake provider page: popup
 * (token given, and fetched after the click), a popup the user closes, the API-key form, redirect
 * mode, and a second browser that can't finish someone else's flow.
 */
import { apiKey, defineConnection, oauth2 } from "@openconnect/connections";
import { fakeOAuth } from "@openconnect/connections/testing";
import { importHmacKey, importKeys } from "@openconnect/kernel";
import { memory } from "@openconnect/kernel/memory";
import { runtime, sessions } from "@openconnect/runtime";

const RT = "http://localhost:8788",
  APP = "http://127.0.0.1:5173";
const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
const example = defineConnection({
  id: "example",
  auth: oauth2<{ clientId: string }>({ authorizeUrl: `${RT}/fake/authorize`, tokenUrl: "https://example.test/token" }),
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
  config: { example: { clientId: "cid" }, keyed: null },
  fetch: p.fetch,
  sessions: { key: await importHmacKey(key(5)), origins: [APP] },
};
const rt = runtime({ definitions: { example, keyed }, settings: async () => settings, extensions: [sessions()] });
const w = memory(rt.program, { now: Date.now() });
const rtServer = Bun.serve({
  port: 8788,
  hostname: "localhost",
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/fake/authorize") {
      const b = p.approve(req.url);
      return new Response(`<p>Provider consent</p><a id=ok href="${RT}/callback?code=${b.code}&state=${encodeURIComponent(b.state)}">Allow</a>`, {
        headers: { "content-type": "text/html" },
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
      const args = q.get("return") ? { returnUrl: `${APP}/back` } : { origin: APP };
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
      `<!doctype html><button id=popup>popup</button><button id=lazy>lazy</button><button id=redir>redirect</button><div id=ui></div><pre id=out></pre><script type=module src=/page.js></script>`,
      { headers: { "content-type": "text/html" } },
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
  const [popup2] = await Promise.all([page.waitForEvent("popup"), page.click("#popup")]);
  await popup2.waitForSelector("#ok");
  await popup2.close();
  await page.waitForFunction(() => document.getElementById("out")!.textContent!.includes("closed"), null, { timeout: 5000 });
  check("closed detected", (await page.textContent("#out")) === 'popup:{"status":"closed"}');
  // API-key form
  await page.fill("#ui input[name=apiKey]", "sk-123");
  await page.click("#ui button");
  await page.waitForFunction(() => document.getElementById("out")!.textContent!.startsWith("form:"));
  check(
    "form",
    (await page.textContent("#out")) === 'form:{"status":"connected"}' && (await state("keyed", "k1")) === "active",
    await page.textContent("#out"),
  );
  // redirect mode
  await page.click("#redir");
  await page.waitForSelector("#ok");
  await page.click("#ok");
  await page.waitForURL(`${APP}/back?openconnect=connected`);
  await page.waitForFunction(() => document.getElementById("out")!.textContent!.startsWith("redirect:"));
  check("redirect", (await page.textContent("#out")) === 'redirect:{"status":"connected"}' && (await state("example", "r1")) === "active");
  // CSRF: a link (no form, no Origin) can't start; another browser context (no cookie) can't finish
  const t = await (await fetch(`${APP}/token?def=example&id=x1`)).json();
  const res = await rt.fetch(
    new Request(`${RT}/session/authorize`, {
      method: "POST",
      headers: { origin: APP },
      body: new URLSearchParams({ token: t.token, mode: "popup", nonce: "" }),
    }),
    w.call,
  );
  const loc = res.headers.get("location")!;
  const victim = await (await browser.newContext()).newPage();
  await victim.goto(loc);
  await victim.click("#ok");
  check("victim browser refused (no binding cookie)", (await victim.content()).includes("session_mismatch") && (await state("example", "x1")) === "pending");
} finally {
  await browser.close();
  rtServer.stop();
  appServer.stop();
}
