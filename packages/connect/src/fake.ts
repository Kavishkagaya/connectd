import { apiKey, defineConnection, oauth2 } from "@openconnect/connections";
import { fakeOAuth } from "@openconnect/connections/testing";
import { importHmacKey, importKeys } from "@openconnect/kernel";
import { memory } from "@openconnect/kernel/memory";
import { runtime, sessions } from "@openconnect/runtime";

/**
 * Tests only: just enough of a browser window (DOM elements, window.open, location, postMessage,
 * timers) to drive `connect()` and `mount()`, in front of the real runtime on the memory driver.
 * The fake plays the browser's part: the page's fetches carry its Origin, a navigation carries
 * nothing (as from a `Referrer-Policy: no-referrer` page), the provider approves, the callback runs
 * with the binding cookie, and the popup page's postMessage is delivered.
 */

export const APP = "https://app.test";
export const OC = "https://oc.test";
const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));

type Listener = (e: any) => void;

export class El {
  [prop: string]: any;
  children: El[] = [];
  parent: El | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  style: Record<string, string> = {};
  textContent = "";
  constructor(
    readonly tagName: string,
    readonly win: FakeWindow,
  ) {}
  appendChild(c: El) {
    c.remove();
    c.parent = this;
    this.children.push(c);
    return c;
  }
  replaceChildren(...cs: El[]) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    for (const c of cs) this.appendChild(c);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(t: string, f: Listener) {
    (this.listeners[t] ??= []).push(f);
  }
  dispatch(t: string) {
    for (const f of this.listeners[t] ?? []) f({ type: t, preventDefault() {} });
  }
  all(tag: string): El[] {
    return this.children.flatMap((c) => [...(c.tagName === tag ? [c] : []), ...c.all(tag)]);
  }
}

export type Popup = { name: string; closed: boolean; close(): void; location: { href: string } };

export class FakeWindow {
  now = 0;
  timers: { id: number; at: number; every?: number; fn: () => void }[] = [];
  nextId = 1;
  messages: Listener[] = [];
  opened: Popup[] = [];
  /** Top-level navigations: the popup's (`popup`) or this page's. */
  navigations: { url: string; popup?: Popup }[] = [];
  location = { href: `${APP}/`, assign: (url: string) => void this.navigations.push({ url }) };
  /** `replaceState` rewrites the address bar in place (no navigation). */
  history = { state: null, replaced: [] as string[], replaceState: (_s: unknown, _t: string, url: string) => void (this.history.replaced.push(url), (this.location.href = url)) };
  name = "";
  closed = false;
  blockPopups = false;
  crypto = globalThis.crypto;
  document = { createElement: (t: string) => new El(t, this), body: new El("body", this) };
  constructor(readonly fetch: (input: string, init?: RequestInit) => Promise<Response>) {}
  open(_url: string, name: string): Popup | null {
    if (this.blockPopups) return null;
    const nav = this.navigations;
    const p: Popup = {
      name,
      closed: false,
      close: () => void (p.closed = true),
      location: {
        set href(url: string) {
          nav.push({ url, popup: p });
        },
        get href() {
          return "about:blank";
        },
      },
    };
    this.opened.push(p);
    return p;
  }
  close() {
    this.closed = true;
  }
  addEventListener(t: string, f: Listener) {
    if (t === "message") this.messages.push(f);
  }
  removeEventListener(t: string, f: Listener) {
    if (t === "message") this.messages = this.messages.filter((x) => x !== f);
  }
  /** A message event as the browser would deliver it. */
  post(data: unknown, origin: string, source: unknown) {
    for (const f of [...this.messages]) f({ data, origin, source });
  }
  setTimeout(fn: () => void, ms: number) {
    this.timers.push({ id: this.nextId, at: this.now + ms, fn });
    return this.nextId++;
  }
  setInterval(fn: () => void, ms: number) {
    this.timers.push({ id: this.nextId, at: this.now + ms, every: ms, fn });
    return this.nextId++;
  }
  clearTimeout(id: number) {
    this.timers = this.timers.filter((t) => t.id !== id);
  }
  clearInterval(id: number) {
    this.clearTimeout(id);
  }
  /** Move the clock, firing due timers in order. */
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const t = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!t) break;
      this.now = t.at;
      if (t.every) t.at += t.every;
      else this.clearTimeout(t.id);
      t.fn();
    }
    this.now = end;
  }
}

export async function setup() {
  const example = defineConnection({
    id: "example",
    auth: oauth2<{ clientId: string }>({ authorizeUrl: "https://example.test/authorize", tokenUrl: "https://example.test/token" }),
  });
  const keyed = defineConnection({ id: "keyed", auth: apiKey(["apiKey", "region"]) });
  const p = fakeOAuth({ tokenUrl: "https://example.test/token", issue: (n) => ({ access_token: `a${n}` }), error: () => ({ status: 400, body: { error: "invalid_grant" } }) });
  const settings = {
    keys: await importKeys({ 1: key(1) }, 1),
    stateKey: await importHmacKey(key(9)),
    apiKey: "secret",
    redirectUri: `${OC}/callback`,
    config: { example: { clientId: "cid" }, keyed: null },
    fetch: p.fetch,
    sessions: { key: await importHmacKey(key(5)), origins: [APP] },
  };
  const rt = runtime({ definitions: { example, keyed }, settings: async () => settings, extensions: [sessions()], now: Date.now });
  const w = memory(rt.program, { now: Date.now() });
  const send = (path: string, init: RequestInit = {}) => rt.fetch(new Request(`${OC}${path}`, init), w.call);

  /** The app's backend issuing a session. */
  const token = async (def: string, id: string, args: Record<string, unknown> = { origin: APP }) => {
    const res = await send(`/connections/${def}/${id}/session`, { method: "POST", headers: { authorization: "Bearer secret" }, body: JSON.stringify(args) });
    return ((await res.json()) as { token: string }).token;
  };
  const status = async (def: string, id: string) => ((await (await send(`/connections/${def}/${id}`, { headers: { authorization: "Bearer secret" } })).json()) as { state: string }).state;

  // The page's fetch: cross-origin, so the browser adds Origin.
  const requests: { path: string; body: unknown }[] = [];
  const win = new FakeWindow((input, init = {}) => {
    requests.push({ path: new URL(input).pathname, body: init.body ? JSON.parse(String(init.body)) : null });
    return send(new URL(input).pathname, { ...init, headers: { ...(init.headers as Record<string, string>), origin: APP } });
  });

  /**
   * Play the browser for the last navigation: GET the ticket URL (no Origin, no Referer), let the
   * user approve (or deny) at the provider, run the callback with the cookie, and deliver the popup
   * page's message, unless `noOpener` (a provider's COOP cut it): then the popup goes on to the return URL.
   */
  const finish = async (o: { deny?: string; noOpener?: boolean } = {}) => {
    const nav = win.navigations.at(-1)!;
    const res = await send(new URL(nav.url).pathname + new URL(nav.url).search);
    if (res.status !== 303) throw new Error(`authorize ${res.status}: ${await res.text()}`);
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const back = p.approve(res.headers.get("location")!);
    const q = o.deny ? `error=${o.deny}` : `code=${back.code}`;
    const done = await send(`/callback?${q}&state=${encodeURIComponent(back.state)}`, { headers: { cookie } });
    const html = await done.text();
    const m = /postMessage\((\{.*?\}), "([^"]+)"\); window.close\(\); \} else if \((.*?)\) location/.exec(html);
    const popup = nav.popup;
    let returnUrl: string | null = null;
    // The browser drops a message whose target origin isn't the opener's.
    if (m && popup && !o.noOpener && JSON.parse(`"${m[2]}"`) === APP) {
      win.post(JSON.parse(m[1]!), OC, popup);
      popup.close();
    } else if (m) returnUrl = JSON.parse(m[3]!);
    return { done, html, location: done.headers.get("location"), returnUrl };
  };
  return { win, token, status, finish, send, requests };
}
