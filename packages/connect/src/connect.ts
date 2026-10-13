/**
 * The headless browser side of a connect session (#29). The app's backend gets a session token
 * (`oc.connection(def, id).session({ origin })`, server SDK) and hands it to the page; the page
 * calls `connect()` from a click. Browser APIs only, no dependencies.
 *
 *   button.onclick = async () => {
 *     const r = await connect({ url: "https://connect.example.com", token });
 *     if (r.status === "connected") ...
 *   };
 */

/** `GET /session` (the runtime's `SessionInfo`). */
// ponytail: copied from @openconnect/runtime to keep this package dependency-free; move both to a shared types package with the SDK's.
export type SessionInfo = {
  definition: string;
  id: string;
  /** `redirect`: authorize at the provider. `form`: the user enters `fields` (API keys). */
  flow: "redirect" | "form";
  fields: string[];
  state: string | null;
  reason?: string;
  expiresAt: number;
};

export type Result =
  | { status: "connected" }
  /** The runtime or the provider said no (`access_denied`, `bad_request`, `session_expired`...), or `timeout`, `popup_blocked`. */
  | { status: "error"; code: string; message: string }
  /** The popup was closed before it reported. `session()` tells the connection's state. */
  | { status: "closed" }
  /** The page is navigating away (redirect mode); the result comes back on the return URL (`readResult`). */
  | { status: "redirecting" };

export type Token = string | (() => Promise<string>);

export type ConnectOptions = {
  /** Base URL of the runtime. */
  url: string;
  /** The session token, or a function that fetches one from the app's backend (the popup opens first, then waits for it). */
  token: Token;
  /** Default `popup`. `redirect` navigates this window and needs a session with a `returnUrl`. */
  mode?: "popup" | "redirect";
  /** API-key definitions (`flow: "form"`): the user's input. Sent with fetch; no window opens. */
  fields?: Record<string, string>;
  /** When the popup is blocked, redirect instead (if the session has a `returnUrl`). Default true. */
  fallback?: boolean;
  /** Give up on the popup after this long, and close it. Default 10 min (a handshake's life). */
  timeoutMs?: number;
  /** Tests pass a fake. Default the global `window`. */
  window?: Window;
};

const err = (code: string, message: string): Result => ({ status: "error", code, message });
const base = (url: string) => url.replace(/\/+$/, "");

/** A session token's claims. Signed by the runtime, not secret; read here only to know if a redirect can come back. */
export function claims(token: string): { def: string; id: string; exp: number; origin: string; returnUrl?: string } | null {
  try {
    const b = (token.split(".")[0] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

async function call(win: Window, url: string, path: string, token: string, init: RequestInit = {}) {
  const res = await win.fetch(`${base(url)}/session${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  return { ok: res.ok, body, error: body?.error ?? { code: "http_error", message: `HTTP ${res.status}` } };
}

/** What to render for this session: the flow, the fields of a form, the connection's state. Throws on a refused token. */
export async function session(o: { url: string; token: string; window?: Window }): Promise<SessionInfo> {
  const r = await call(o.window ?? window, o.url, "", o.token);
  if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
  return r.body as unknown as SessionInfo;
}

/**
 * Submit a hidden form to `/session/authorize`, top level, into `target` (the popup's name, or
 * `_self`). A form POST, not a link: the token stays out of URLs and history, and the browser sends
 * `Origin`, which the runtime checks against the session.
 */
function submit(win: Window, url: string, fields: Record<string, string>, target: string) {
  const doc = win.document;
  const form = doc.createElement("form");
  form.method = "POST";
  form.action = `${base(url)}/session/authorize`;
  form.target = target;
  form.style.display = "none";
  for (const [name, value] of Object.entries(fields)) {
    const input = doc.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  doc.body.appendChild(form);
  form.submit();
  form.remove();
}

function nonce(win: Window) {
  return Array.from(win.crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Wait for the popup's message (from the runtime's origin, from that window, with our nonce), its closing, or the timeout. */
function wait(win: Window, popup: Window, origin: string, n: string, timeoutMs: number): Promise<Result> {
  return new Promise((resolve) => {
    let closedOnce = false;
    const done = (r: Result) => {
      win.removeEventListener("message", onMessage);
      win.clearInterval(poll);
      win.clearTimeout(timer);
      resolve(r);
    };
    function onMessage(e: MessageEvent) {
      const d = e.data as { type?: unknown; nonce?: unknown; status?: unknown; code?: unknown; message?: unknown } | null;
      if (e.origin !== origin || e.source !== popup || !d || d.type !== "openconnect" || d.nonce !== n) return;
      done(d.status === "connected" ? { status: "connected" } : err(String(d.code ?? "error"), String(d.message ?? "")));
    }
    win.addEventListener("message", onMessage);
    // The page posts, then closes itself: give a message already in flight one more tick to land.
    const poll = win.setInterval(() => {
      if (!popup.closed) return;
      if (closedOnce) done({ status: "closed" });
      closedOnce = true;
    }, 300);
    const timer = win.setTimeout(() => {
      popup.close();
      done(err("timeout", "the popup did not finish in time"));
    }, timeoutMs);
  });
}

/**
 * Connect: a popup (default) or a redirect to the provider, or an API-key form's fields.
 * Call it synchronously from a user gesture (a click handler): the popup opens before anything is
 * awaited, or the browser blocks it. Never throws; every outcome is a `Result`.
 */
export function connect(o: ConnectOptions): Promise<Result> {
  const win = o.window ?? window;
  const mode = o.mode ?? "popup";
  const n = nonce(win);
  const name = `openconnect-${n}`;
  // Open first (blank), navigate after: the gesture only counts until the first await.
  const popup = !o.fields && mode === "popup" ? win.open("", name, "popup,width=520,height=680") : null;

  return (async (): Promise<Result> => {
    const token = typeof o.token === "string" ? o.token : await o.token();
    if (o.fields) {
      const r = await call(win, o.url, "/connect", token, { method: "POST", body: JSON.stringify({ fields: o.fields }) });
      if (!r.ok) return err(r.error.code, r.error.message);
      const state = (r.body as { state?: string } | null)?.state;
      return state === "active" ? { status: "connected" } : err("not_active", `connection is ${state}`);
    }
    if (mode === "popup" && popup) {
      submit(win, o.url, { token, mode, nonce: n }, name);
      return wait(win, popup, new URL(o.url).origin, n, o.timeoutMs ?? 600_000);
    }
    if (mode === "popup" && (o.fallback === false || !claims(token)?.returnUrl)) return err("popup_blocked", "the browser blocked the popup");
    submit(win, o.url, { token, mode: "redirect", nonce: n }, "_self");
    return { status: "redirecting" };
  })().catch((e) => {
    popup?.close();
    return err("error", e instanceof Error ? e.message : String(e));
  });
}

/** After a redirect-mode flow: the result on the return URL (`?openconnect=connected|error&code=`), or null if there is none. */
export function readResult(href: string = window.location.href): Result | null {
  const q = new URL(href).searchParams;
  const s = q.get("openconnect");
  if (s === "connected") return { status: "connected" };
  if (s === "error") return err(q.get("code") ?? "error", "");
  return null;
}
