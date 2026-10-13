import { expect, test } from "bun:test";
import { KEY, start, type Win } from "./app.ts";
import { API_KEY, browser, type El, setup } from "./fake.ts";

/** The UI on a fake browser in front of the real runtime + dashboard() on the memory driver. */
async function ui(o: { signedIn?: boolean; hash?: string } = {}) {
  const t = await setup();
  const b = browser(t.fetch);
  if (o.signedIn !== false) b.store.set(KEY, API_KEY);
  if (o.hash) b.win.location.hash = o.hash;
  const app = start(b.win as unknown as Win);
  const idle = async () => {
    // Hash changes land on a microtask; let them start, then wait for the work they began.
    await new Promise((r) => setTimeout(r, 0));
    await app.idle();
  };
  await idle();
  const go = async (hash: string) => ((b.win.location.hash = hash), idle());
  const click = async (tag: string, label: string, root: El = b.root) => (root.get(tag, label).click(), idle());
  return { ...t, ...b, app, idle, go, click, text: () => b.root.text };
}

test("sign in: a wrong key is refused, the right one is kept in sessionStorage and sent as a Bearer header", async () => {
  const u = await ui({ signedIn: false });
  expect(u.text()).toContain("Sign in");
  u.root.get("input", "key").value = "wrong";
  await u.click("button", "Sign in");
  expect(u.text()).toContain("Wrong API key.");
  expect(u.store.has(KEY)).toBe(false);

  u.root.get("input", "key").value = ` ${API_KEY} `;
  await u.click("button", "Sign in");
  expect(u.store.get(KEY)).toBe(API_KEY);
  expect(u.text()).toContain("No connections.");
  expect(u.requests.at(-1)).toEqual({ path: "/connections?", authorization: `Bearer ${API_KEY}` });
  // Never in a URL.
  expect(u.requests.some((r) => r.path.includes(API_KEY))).toBe(false);

  await u.click("button", "Sign out");
  expect(u.store.has(KEY)).toBe(false);
  expect(u.text()).toContain("Sign in");
});

test("a key that stops working (rotated) signs the tab out", async () => {
  const u = await ui();
  u.store.set(KEY, "rotated");
  const app = start(u.win as unknown as Win);
  await app.idle();
  expect(u.store.has(KEY)).toBe(false);
  expect(u.text()).toContain("Sign in");
});

test("connections: list, filter by state through the hash, load more pages", async () => {
  const u = await ui();
  for (const id of ["a", "b", "c"]) await u.api(`/connections/keyed/${id}/connect`, { apiKey: `acct_${id}` });
  await u.api("/connections/keyed/b/revoke", null);
  await u.go("#/?limit=2");
  const rows = () => u.root.all((e) => e.tagName === "tbody")[0]!.all((e) => e.tagName === "tr").map((r) => r.text);
  expect(rows().length).toBe(2);
  expect(rows()[0]).toContain("keyedaactive");
  expect(rows()[0]).toContain("account=acct_a");
  await u.click("button", "Load more");
  expect(rows().length).toBe(3);
  expect(u.text()).not.toContain("Load more");

  u.root.get("select", "state").value = "revoked";
  await u.click("button", "Filter");
  expect(u.win.location.hash).toBe("#/?state=revoked");
  expect(rows()).toEqual([expect.stringContaining("keyedbrevoked")]);
  // The filter form shows what the hash says.
  expect(u.root.get("select", "state").value).toBe("revoked");

  u.root.get("input", "search").value = "acct_c";
  u.root.get("select", "state").value = "";
  await u.click("button", "Filter");
  expect(rows()).toEqual([expect.stringContaining("keyedcactive")]);
});

test("one connection: state, metadata, external ids; events parked with their error, delivered now, redelivered", async () => {
  const u = await ui();
  u.failEvents(503);
  await u.api("/connections/keyed/k1/connect", { apiKey: "acct_1" });
  await u.w.advance(0); // first attempt fails
  await u.go("#/c/keyed/k1");
  expect(u.text()).toContain("Stateactive");
  expect(u.text()).toContain("account=acct_1");
  expect(u.root.get("h3", "Metadata").parent!.text).toContain(`"account": "acct_1"`);
  expect(u.text()).toContain("Pending1");
  expect(u.text()).toContain("Last errorHTTP 503");
  expect(u.text()).toContain("Queued (head first)");
  expect(u.text()).toContain("Ingress URLhttps://oc.test/webhooks/keyed/k1");

  u.failEvents(200);
  await u.click("button", "Deliver now");
  expect(u.text()).toContain("Delivery started");
  await u.w.advance(0);
  await u.click("button", "Refresh");
  expect(u.text()).toContain("Pending0");
  expect(u.text()).toContain("Recent (newest first)");
  expect(u.delivered.length).toBe(1);

  await u.click("button", "Redeliver");
  expect(u.text()).toContain("Queued again as slot 2, same webhook-id.");
  await u.w.advance(0);
  expect(u.delivered).toEqual([u.delivered[0]!, u.delivered[0]!]);
});

test("revoke asks first; index sync; a new API-key connection from the form", async () => {
  const u = await ui();
  await u.api("/connections/keyed/k1/connect", { apiKey: "acct_1" });
  await u.go("#/c/keyed/k1");
  u.win.confirmAnswer = false;
  await u.click("button", "Revoke");
  expect(u.text()).toContain("Stateactive");
  u.win.confirmAnswer = true;
  await u.click("button", "Sync index");
  expect(u.text()).toContain("Index row re-copied.");
  await u.click("button", "Revoke");
  expect(u.text()).toContain("Revoked.");
  expect(u.text()).toContain("Staterevoked");
  expect(u.text()).toContain("Reasondashboard");
  expect(u.text()).not.toContain("Re-authorize");

  // Open a new id from the list page, then connect it.
  await u.go("#/");
  u.root.get("select", "definition").value = "keyed";
  const forms = u.root.all((e) => e.tagName === "form");
  const open = forms.find((f) => f.text.includes("Open or start"))!;
  open.get("select", "definition").value = "keyed";
  open.get("input", "id").value = "new/id";
  await u.click("button", "Open", open);
  expect(u.win.location.hash).toBe("#/c/keyed/new%2Fid");
  expect(u.text()).toContain("No connection with this id yet.");
  expect(u.root.get("input", "apiKey").attrs.type).toBe("password");
  u.root.get("input", "apiKey").value = "acct_2";
  await u.click("button", "Connect");
  expect(u.text()).toContain("Connected.");
  expect((await u.api("/connections/keyed/new%2Fid")).body.state).toBe("active");
});

test("OAuth: an authorization link (http(s) only, new tab); unconfigured definitions say so", async () => {
  const u = await ui({ hash: "#/c/example/u1" });
  await u.click("button", "Get an authorization link for example");
  const a = u.root.get("a", "Open the provider's authorization page");
  expect(a.attrs.href).toStartWith("https://example.test/authorize?");
  expect(a.attrs).toMatchObject({ target: "_blank", rel: "noopener noreferrer" });
  await u.go("#/c/absent/u1");
  expect(u.text()).toContain("absent has no connector config");
  await u.go("#/c/nope/u1");
  expect(u.text()).toContain("No definition nope in this deployment.");
});

test("definitions: the URLs to register and what's missing, no secret", async () => {
  const u = await ui({ hash: "#/definitions" });
  const text = u.text();
  expect(text).toContain("Callback URLhttps://oc.test/callback");
  expect(text).toContain("https://app.test/events?…");
  expect(text).toContain("https://oc.test/webhooks/keyed/:id");
  expect(text).toContain("empty: clientId, clientSecret");
  expect(text).toContain("missing: not_configured");
  expect(text).not.toContain("shh-client-secret");
});

test("ids and metadata are text, never markup", async () => {
  const u = await ui();
  const evil = `<img src=x onerror=alert(1)>`;
  await u.api(`/connections/keyed/${encodeURIComponent(evil)}/connect`, { apiKey: evil });
  await u.go("#/");
  // The fake has no parser: anything rendered is a text child; no element was made from the string.
  expect(u.root.all((e) => e.tagName === "img")).toEqual([]);
  expect(u.text()).toContain(evil);
  await u.go(`#/c/keyed/${encodeURIComponent(evil)}`);
  expect(u.root.all((e) => e.tagName === "img")).toEqual([]);
  expect(u.text()).toContain(`account=${evil}`);
});
