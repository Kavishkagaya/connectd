import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

// A DOM for React, at the deployment's dashboard URL; gone after this file. The runtime runs in this
// process too: it keeps Bun's own fetch classes (happy-dom's drop a request's cookie, as a browser would).
const native = { Request, Response, Headers, fetch };
GlobalRegistrator.register({ url: "https://oc.test/dashboard" });
Object.assign(globalThis, native);
const { cleanup, render, screen, waitFor, within } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
const { App } = await import("./App");
const { API_KEY, OC, setup } = await import("../src/fake.ts");
const { every, fields } = await import("./format");

afterAll(() => GlobalRegistrator.unregister());
afterEach(cleanup);
beforeAll(() => {
  // React's act() warnings are noise for a test that waits on the DOM itself.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

/** The real runtime + dashboard behind `fetch`, with a cookie jar, as the browser on this origin. */
async function ui(hash = "#/", o: { root?: boolean } = {}) {
  const t = await setup();
  // A root session: what a CLI link gives.
  let cookie = o.root ? t.cookie : "";
  const requests: { path: string; headers: Headers }[] = [];
  globalThis.fetch = window.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input, OC);
    const headers = new Headers(init?.headers);
    requests.push({ path: url.pathname + url.search, headers });
    if (cookie) headers.set("cookie", cookie);
    if (init?.method === "POST") headers.set("origin", OC);
    const res = await t.fetch(url.pathname + url.search, { ...init, headers });
    const set = res.headers.get("set-cookie");
    if (set) cookie = /Max-Age=0/.test(set) ? "" : (set.split(";")[0] as string);
    return res;
  }) as typeof fetch;
  globalThis.confirm = window.confirm = () => true;
  window.history.replaceState(null, "", `/dashboard${hash}`);
  const user = userEvent.setup();
  render(<App />);
  // Root is first asked for an account: not now.
  if (o.root) await user.click(await screen.findByRole("button", { name: "Not now" }));
  return { t, user, requests };
}

test("a CLI link: signed in as root, asked for an account, then in, and the token is gone from the URL", async () => {
  const s = await setup(); // only for a token: the same admin key as the one ui() builds
  const u = await ui(`#login=${encodeURIComponent(await s.loginToken())}`);
  expect(window.location.hash).toBe("#/");
  await screen.findByText("Create the first account");
  await u.user.type(screen.getByLabelText("Username"), "ann");
  await u.user.click(screen.getByRole("tab", { name: "Password" }));
  await u.user.type(screen.getByLabelText("Password", { selector: "input" }), "correct horse battery");
  await u.user.click(screen.getByRole("button", { name: "Create account" }));
  await screen.findByText("No connections.");
  expect(screen.getByRole("button", { name: /ann/ })).toBeTruthy();
  expect(await u.t.w.platform.db.accounts.get("ann")).toMatchObject({ username: "ann" });
  // The session is a cookie: no key in a URL or a header the page set.
  for (const r of u.requests) {
    expect(r.path).not.toContain(API_KEY);
    expect(r.headers.get("authorization")).toBe(null);
  }
});

test("signed out: a password signs in; a wrong one says so", async () => {
  const u = await ui();
  await u.t.w.platform.db.accounts.create({ username: "bob", password: null, sessions: 0, createdAt: 0 });
  const { hash } = await import("../src/password.ts");
  await u.t.w.platform.db.accounts.password("bob", await hash("correct horse battery"));
  await screen.findByText("Sign in");
  await u.user.type(screen.getByLabelText("Username"), "bob");
  await u.user.type(screen.getByLabelText("Password"), "wrong password!!");
  await u.user.click(screen.getByRole("button", { name: "Sign in with password" }));
  await screen.findByText("wrong username or password");
  await u.user.clear(screen.getByLabelText("Password"));
  await u.user.type(screen.getByLabelText("Password"), "correct horse battery");
  await u.user.click(screen.getByRole("button", { name: "Sign in with password" }));
  await screen.findByText("Connections", { selector: "h1" });
});

test("keys: make one (its secret shown once, as env lines), then revoke it", async () => {
  const u = await ui("#/keys", { root: true });
  await screen.findByText("New key");
  // A root session: the banner offers an account.
  expect(screen.getByText(/one-time CLI link/)).toBeTruthy();
  await u.user.type(screen.getByLabelText("Name"), "web");
  await u.user.click(screen.getByRole("button", { name: /Create/ }));
  const dialog = await screen.findByRole("dialog");
  const shown = within(dialog).getByText(/CONNECTD_API_KEY=ock_/).textContent ?? "";
  expect(shown).toContain(`CONNECTD_URL=${OC}`);
  const key = /CONNECTD_API_KEY=(\S+)/.exec(shown)?.[1] ?? "";
  // It works against the runtime.
  expect((await u.t.fetch("/connections/keyed/x", { headers: { authorization: `Bearer ${key}` } })).status).toBe(404);
  await u.user.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
  // Not shown again in the list.
  expect(document.body.textContent).not.toContain(key);
  await u.user.click(await screen.findByRole("button", { name: "Revoke web" }));
  await screen.findByText("Revoked web.");
  expect((await u.t.fetch("/connections/keyed/x", { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
});

test("a connection: connect with its fields, run an action from its schema's form", async () => {
  const u = await ui("#/c/keyed/k1", { root: true });
  await screen.findByText("No connection with this id yet.");
  await u.user.type(screen.getByLabelText("apiKey"), "sk_live_1");
  await u.user.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByText("Connected.");
  await screen.findByText("active");
  await u.user.click(screen.getByText("Run star"));
  await u.user.type(screen.getByLabelText("repo"), "o/r");
  await u.user.click(screen.getByRole("button", { name: "Run star now" }));
  await screen.findByText(/"starred": "o\/r"/);
});

test("a hostile id is text, never markup", async () => {
  const evil = `<img src=x onerror="window.pwned=1">`;
  await ui(`#/c/keyed/${encodeURIComponent(evil)}`, { root: true });
  await screen.findByText(evil);
  expect(document.querySelector("img")).toBe(null);
  expect((window as { pwned?: number }).pwned).toBeUndefined();
});

test("fields: flat schemas become forms; anything else is JSON", () => {
  expect(fields({ type: "object", properties: { a: { type: "string" }, b: { enum: ["x", "y"] } }, required: ["a"] })).toEqual([
    { name: "a", kind: "string", options: [], required: true, description: "" },
    { name: "b", kind: "enum", options: ["x", "y"], required: false, description: "" },
  ]);
  expect(fields({ type: "object", properties: { a: { type: "object" } } })).toBe(null);
  expect(fields(null)).toBe(null);
  expect(every(600_000)).toBe("10 min");
  expect(every(1500)).toBe("1500 ms");
});
