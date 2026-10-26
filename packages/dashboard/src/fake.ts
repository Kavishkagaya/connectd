import { action, apiKey, defineConnection, hmacHex, oauth2, type StandardSchemaV1, safeEqual } from "@kavishkagaya/connectd-connections";
import { fakeOAuth } from "@kavishkagaya/connectd-connections/testing";
import { importHmacKey, importKeys, type Json } from "@kavishkagaya/connectd-kernel";
import { memory } from "@kavishkagaya/connectd-kernel/memory";
import { directory, type Extension, events, memoryIndex, runtime, webhooks } from "@kavishkagaya/connectd-runtime";
import { dashboard } from "./index.ts";

/**
 * Tests only: the real runtime with dashboard() on the memory driver, and just enough of a browser
 * (elements, text, events, location.hash, sessionStorage, fetch) to drive app.ts against it.
 */

export const OC = "https://oc.test";
export const API_KEY = "test-api-key";
export const CLIENT_SECRET = "shh-client-secret";
export const T0 = 1_700_000_000_000;
const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
export const EVENTS_SECRET = `whsec_${key(7)}`;
const TOKEN = "https://example.test/token";

/** `{ repo: string, stars?: number }`, with its JSON Schema (Standard JSON Schema), like zod 4 gives. */
const repoInput = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (v: unknown) =>
      typeof v === "object" && v !== null && typeof (v as { repo?: unknown }).repo === "string"
        ? { value: v as { repo: string; stars?: number } }
        : { issues: [{ message: "Expected string", path: ["repo"] }] },
    jsonSchema: { input: () => ({ type: "object", properties: { repo: { type: "string", description: "owner/name" }, stars: { type: "number" } }, required: ["repo"] }) },
  },
} as StandardSchemaV1<{ repo: string; stars?: number }>;
/** A schema without a JSON Schema: the form falls back to a JSON text box. */
const anyInput: StandardSchemaV1<Json> = { "~standard": { version: 1, vendor: "test", validate: (v) => ({ value: v as Json }) } };
const subInput: StandardSchemaV1<{ repo: string }> = {
  "~standard": { version: 1, vendor: "test", validate: (v) => (typeof (v as { repo?: unknown })?.repo === "string" ? { value: v as { repo: string } } : { issues: [{ message: "repo" }] }) },
};

/** Scheduled `tick` fails while this is above 0. */
export const tickFailures = { left: 0 };
const keyedActions = {
  star: action({ input: repoInput, run: async (_c, { repo, stars }) => ({ starred: repo, stars: stars ?? null }) }),
  echo: action({ input: anyInput, run: async (_c, v) => ({ echo: v }) }),
  tick: action({
    every: 10 * 60_000,
    run: async () => {
      if (tickFailures.left > 0) {
        tickFailures.left--;
        throw new Error("provider down");
      }
      return { ok: true };
    },
  }),
};

const keyed = defineConnection({
  id: "keyed",
  auth: apiKey(["apiKey"]),
  metadata: async (_ctx, cred) => ({ account: cred.kind === "static" ? (cred.fields.apiKey ?? "") : "" }),
  external: (m) => ({ account: m.account }),
  proxy: { baseUrl: "https://api.keyed.test" },
  webhooks: {
    verify: async (_ctx, req, secret) => safeEqual(req.headers.get("x-sig") ?? "", await hmacHex(secret ?? "app", req.body)),
    parse: (req) => ({ topic: (JSON.parse(req.body) as { topic?: string }).topic ?? "push", payload: JSON.parse(req.body) as Json }),
    subscription: subInput,
    register: async (_ctx, _cred, _endpoint, input) => ({ hook: { repo: input.repo } }),
    unregister: async () => {},
  },
});
const oauth = (id: string) => defineConnection({ id, auth: oauth2<{ clientId: string; clientSecret?: string }>({ authorizeUrl: "https://example.test/authorize", tokenUrl: TOKEN }) });

export async function setup(o: { extensions?: Extension[] } = {}) {
  let status = 200;
  const delivered: string[] = [];
  const p = fakeOAuth({ tokenUrl: TOKEN, issue: (n) => ({ access_token: `a${n}` }), error: () => ({ status: 400, body: { error: "invalid_grant" } }) });
  const settings = {
    keys: await importKeys({ 1: key(1) }, 1),
    stateKey: await importHmacKey(key(9)),
    apiKey: API_KEY,
    redirectUri: `${OC}/callback`,
    config: { keyed: null, example: { clientId: "cid", clientSecret: CLIENT_SECRET }, half: { clientId: "", clientSecret: undefined } },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("https://app.test/events")) {
        if (status < 300) delivered.push(init?.body as string);
        return new Response(null, { status });
      }
      return p.fetch(url, init);
    }) as typeof fetch,
    events: { url: "https://app.test/events?token=in-the-url", secret: EVENTS_SECRET },
    webhooks: { url: `${OC}/webhooks`, key: await importHmacKey(key(5)) },
    sessions: { key: await importHmacKey(key(4)), origins: ["https://app.test"] },
  };
  let w: ReturnType<typeof memory> | undefined;
  const rt = runtime({
    definitions: { keyed, example: oauth("example"), half: oauth("half"), absent: oauth("absent") },
    actions: { keyed: keyedActions },
    settings: async () => settings,
    extensions: o.extensions ?? [events(), webhooks(), directory(memoryIndex()), dashboard()],
    now: () => w!.now(),
  });
  w = memory(rt.program, { now: T0 });
  const send = (path: string, init: RequestInit = {}) => rt.fetch(new Request(new URL(path, OC), init), w!.call);
  const api = async (path: string, body?: Json, method = body === undefined ? "GET" : "POST") => {
    const res = await send(path, { method, headers: { authorization: `Bearer ${API_KEY}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { w, rt, fetch: send, api, delivered, failEvents: (s: number) => void (status = s) };
}

// The fake browser.

type Listener = (e: { type: string; preventDefault(): void }) => void;
type Kid = El | string;

export class El {
  children: Kid[] = [];
  parent: El | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  private typed: string | undefined;
  constructor(readonly tagName: string) {}
  append(...ks: Kid[]) {
    for (const k of ks) {
      if (k instanceof El) (k.parent?.remove(k), (k.parent = this));
      this.children.push(k);
    }
  }
  replaceChildren(...ks: Kid[]) {
    this.children = [];
    this.append(...ks);
  }
  remove(k: El) {
    this.children = this.children.filter((c) => c !== k);
  }
  get firstChild(): Kid | null {
    return this.children[0] ?? null;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(t: string, f: Listener) {
    (this.listeners[t] ??= []).push(f);
  }
  /** An input's or select's value: what was typed (`set value`), else the markup's default. */
  get value(): string {
    if (this.typed !== undefined) return this.typed;
    if (this.tagName === "select") {
      const opts = this.all((e) => e.tagName === "option");
      return (opts.find((x) => "selected" in x.attrs) ?? opts[0])?.attrs.value ?? "";
    }
    return this.attrs.value ?? "";
  }
  set value(v: string) {
    this.typed = v;
  }
  get text(): string {
    return this.children.map((c) => (typeof c === "string" ? c : c.text)).join("");
  }
  all(f: (e: El) => boolean): El[] {
    return this.children.flatMap((c) => (typeof c === "string" ? [] : [...(f(c) ? [c] : []), ...c.all(f)]));
  }
  /** The first element with this tag whose text (or `name` / `aria-label`) is `label`. */
  get(tag: string, label: string): El {
    const e = this.all((x) => x.tagName === tag && (x.text === label || x.attrs.name === label || x.attrs["aria-label"] === label))[0];
    if (!e) throw new Error(`no <${tag}> ${label} in: ${this.text}`);
    return e;
  }
  fire(type: string) {
    for (const f of this.listeners[type] ?? []) f({ type, preventDefault() {} });
  }
  /** A button's click, or a submit button's form submit. */
  click() {
    if (this.attrs.type === "submit") {
      let f: El | null = this.parent;
      while (f && f.tagName !== "form") f = f.parent;
      return f?.fire("submit");
    }
    this.fire("click");
  }
}

export function browser(fetch: (path: string, init?: RequestInit) => Promise<Response>) {
  const root = new El("main");
  const store = new Map<string, string>();
  const listeners: (() => void)[] = [];
  let hash = "";
  const requests: { path: string; authorization: string | null }[] = [];
  const win = {
    confirmAnswer: true,
    document: { getElementById: (id: string) => (id === "app" ? root : null), createElement: (t: string) => new El(t) },
    location: {
      get hash() {
        return hash;
      },
      set hash(v: string) {
        hash = v.startsWith("#") ? v : `#${v}`;
        // Async, as in a browser.
        queueMicrotask(() => listeners.forEach((f) => f()));
      },
    },
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    fetch: (path: string, init?: RequestInit) => (requests.push({ path, authorization: new Headers(init?.headers).get("authorization") }), fetch(path, init)),
    addEventListener: (_t: string, f: () => void) => void listeners.push(f),
    removeEventListener: (_t: string, f: () => void) => void listeners.splice(listeners.indexOf(f), 1),
    confirm: () => win.confirmAnswer,
  };
  return { win, root, store, requests };
}
