/**
 * The headless browser side of a connect session (#29). The app's backend gets a session token
 * (`oc.connection(def, id).session({ origin })`, server SDK) and hands it to the page; the page
 * calls `connect()` from a click. Browser APIs only, no dependencies.
 *
 *   button.onclick = async () => {
 *     const r = await connect({ url: "https://connect.example.com", token });
 *     if (r.status === "connected") ...
 *   };
 *   // redirect mode, on the return URL's page:
 *   const r = await resume({ url, token });
 *
 * The flow: open the popup (blank) → `POST /session/authorize` with fetch → a single-use ticket →
 * navigate the popup (or this page) to `GET /session/authorize?ticket=` → provider → `/callback`,
 * which posts a `completion` back (or puts it in the return URL's fragment) → `POST /session/complete`.
 */

/** `GET /session` (the runtime's `SessionInfo`). */
// ponytail: copied from @kavishkagaya/connectd-runtime to keep this package dependency-free; move both to a shared types package with the SDK's.
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
  /** The popup was closed before it reported, and the connection isn't active. */
  | { status: "closed" }
  /** The page is navigating away (redirect mode); the result comes back on the return URL (`resume`). */
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
  /** Abort the attempt (a second click starting over): closes the popup, resolves `{ status: "error", code: "aborted" }`. */
  signal?: AbortSignal;
  /** Called once when the popup reads as closed. The result may still come (COOP); a UI can re-enable its button here. */
  onClosed?(): void;
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

function nonce(win: Window) {
  return Array.from(win.crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
}

const TICK_MS = 300;
/** A popup that reads as closed this soon after it went to the provider was most likely cut by the provider's COOP, not closed by the user. */
const COOP_MS = 5_000;
/** While waiting out a COOP popup, how often to look at the connection's state. */
const LOOK_MS = 2_000;

/** What the callback hands back: a completion to confirm, or the end already. */
type Back = Result | { status: "authorized"; completion: string };

/** Session errors no wait outlives: the token is dead or refused. */
const TERMINAL = new Set(["session_expired", "unauthorized", "forbidden", "not_found", "not_configured"]);

/** The channel a popup cut off by COOP reports on, from the app's return URL page (same origin, so only the app hears it). */
const channel = (win: Window, n: string) => {
  const BC = (win as unknown as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  return BC ? new BC(`connectd:${n}`) : null;
};

/**
 * Wait for the popup's result: its message (from the runtime's origin, from that window, with our
 * nonce), a broadcast from `resume()` on the return URL (COOP), or its closing, or the timeout.
 *
 * Closed is ambiguous: a provider page with COOP `same-origin` makes the popup read as closed the
 * moment it gets there, while the user is still logging in. Closed soon after the popup left
 * (`COOP_MS`) is taken as that: keep waiting (broadcast, and the state every `LOOK_MS`) until the
 * connection is active, revoked, or the timeout, then `closed`. Closed later is the user: one look
 * at the state, then `closed`.
 */
type Wait = { timeoutMs: number; state: () => Promise<string | null>; signal?: AbortSignal; onClosed?(): void };

function wait(win: Window, popup: Window, origin: string, n: string, w: Wait): Promise<Back> {
  const { timeoutMs, state } = w;
  return new Promise((resolve) => {
    let ticks = 0;
    let closedAt: number | null = null;
    let looking = false;
    const bc = channel(win, n);
    const done = (r: Back) => {
      win.removeEventListener("message", onMessage);
      win.clearInterval(poll);
      win.clearTimeout(timer);
      bc?.close();
      w.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    function onAbort() {
      popup.close();
      done(err("aborted", "aborted"));
    }
    w.signal?.addEventListener("abort", onAbort);
    const result = (d: { status?: unknown; code?: unknown; message?: unknown }): Result =>
      d.status === "connected" ? { status: "connected" } : err(String(d.code ?? "error"), String(d.message ?? ""));
    function onMessage(e: MessageEvent) {
      const d = e.data as { type?: unknown; nonce?: unknown; status?: unknown; completion?: unknown; code?: unknown; message?: unknown } | null;
      if (e.origin !== origin || e.source !== popup || !d || d.type !== "connectd" || d.nonce !== n) return;
      if (d.status === "authorized" && typeof d.completion === "string") done({ status: "authorized", completion: d.completion });
      else done(result(d));
    }
    win.addEventListener("message", onMessage);
    if (bc)
      bc.onmessage = (e: MessageEvent) => {
        const d = e.data as { type?: unknown; nonce?: unknown; status?: unknown } | null;
        if (!d || d.type !== "connectd" || d.nonce !== n || d.status === "authorized") return;
        // Same origin, so any of the app's pages could say it: check the state before believing a `connected`.
        if (d.status === "connected") state().then((s) => s === "active" && done({ status: "connected" }), () => {});
        else done(result(d));
      };
    const look = (last: boolean) => {
      if (looking) return;
      looking = true;
      state()
        .then((s) => {
          if (s === "active") done({ status: "connected" });
          else if (last || s === "revoked") done({ status: "closed" });
        })
        .catch((e: { code?: string }) => (last || TERMINAL.has(e.code ?? "")) && done({ status: "closed" }))
        .finally(() => (looking = false));
    };
    const poll = win.setInterval(() => {
      ticks++;
      if (!popup.closed) return;
      // The page posts, then closes itself: give a message already in flight one more tick to land.
      if (closedAt === null) {
        closedAt = ticks;
        return void w.onClosed?.();
      }
      if (ticks === closedAt + 1) return look(closedAt * TICK_MS >= COOP_MS);
      if ((ticks - closedAt) % Math.round(LOOK_MS / TICK_MS) === 0) look(false);
    }, TICK_MS);
    const timer = win.setTimeout(() => {
      popup.close();
      done(closedAt === null ? err("timeout", "the popup did not finish in time") : { status: "closed" });
    }, timeoutMs);
  });
}

/** The app's page confirms what the callback handed it: that activates the connection. */
async function confirm(win: Window, url: string, token: string, completion: string): Promise<Result> {
  const r = await call(win, url, "/complete", token, { method: "POST", body: JSON.stringify({ completion }) });
  if (!r.ok) return err(r.error.code, r.error.message);
  const state = (r.body as { state?: string } | null)?.state;
  return state === "active" ? { status: "connected" } : err("not_active", `connection is ${state}`);
}

/**
 * Connect: a popup (default) or a redirect to the provider, or an API-key form's fields.
 * Call it synchronously from a user gesture (a click handler): the popup opens before anything is
 * awaited, or the browser blocks it. Never throws; every outcome is a `Result`.
 */
export function connect(o: ConnectOptions): Promise<Result> {
  const win = o.window ?? window;
  const n = nonce(win);
  // Open first (blank), navigate after: the gesture only counts until the first await.
  if (o.signal?.aborted) return Promise.resolve(err("aborted", "aborted"));
  const popup = !o.fields && (o.mode ?? "popup") === "popup" ? win.open("", `connectd-${n}`, "popup,width=520,height=680") : null;
  const aborted = () => {
    if (!o.signal?.aborted) return false;
    popup?.close();
    return true;
  };

  return (async (): Promise<Result> => {
    const token = typeof o.token === "string" ? o.token : await o.token();
    if (aborted()) return err("aborted", "aborted");
    if (o.fields) {
      const r = await call(win, o.url, "/connect", token, { method: "POST", body: JSON.stringify({ fields: o.fields }) });
      if (!r.ok) return err(r.error.code, r.error.message);
      const state = (r.body as { state?: string } | null)?.state;
      return state === "active" ? { status: "connected" } : err("not_active", `connection is ${state}`);
    }
    if ((o.mode ?? "popup") === "popup" && !popup && (o.fallback === false || !claims(token)?.returnUrl)) return err("popup_blocked", "the browser blocked the popup");
    const mode = popup ? "popup" : "redirect";
    // A fetch, so the runtime sees this page's real Origin whatever its Referrer-Policy. Errors land here, not in the popup.
    const r = await call(win, o.url, "/authorize", token, { method: "POST", body: JSON.stringify({ mode, nonce: n }) });
    if (!r.ok) {
      popup?.close();
      return err(r.error.code, r.error.message);
    }
    if (aborted()) return err("aborted", "aborted");
    const next = `${base(o.url)}/session/authorize?ticket=${encodeURIComponent((r.body as unknown as { ticket: string }).ticket)}`;
    if (!popup) {
      win.location.assign(next);
      return { status: "redirecting" };
    }
    // Closed while we waited for the token or the ticket: navigating it now would open a new tab.
    if (popup.closed) return { status: "closed" };
    popup.location.href = next;
    const state = async () => (await session({ url: o.url, token, window: win })).state;
    const back = await wait(win, popup, new URL(o.url).origin, n, {
      timeoutMs: o.timeoutMs ?? 600_000,
      state,
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.onClosed ? { onClosed: o.onClosed } : {}),
    });
    return back.status === "authorized" ? confirm(win, o.url, token, back.completion) : back;
  })().catch((e) => {
    popup?.close();
    return err("error", e instanceof Error ? e.message : String(e));
  });
}

/** The outcome keys the runtime puts in the return URL's fragment. */
const KEYS = ["connectd", "definition", "id", "completion", "code", "nonce"];

/**
 * On the return URL's page, after a redirect (or a popup that lost its opener): if the fragment
 * carries an outcome for this token's connection, remove it from the address bar (and history) and
 * confirm it. Null if there is none, or it is another connection's (several buttons on one page:
 * each `resume()` takes only its own). A popup closes itself after.
 */
export async function resume(o: { url: string; token: Token; window?: Window }): Promise<Result | null> {
  const win = o.window ?? window;
  const here = new URL(win.location.href);
  const f = new URLSearchParams(here.hash.slice(1));
  const status = f.get("connectd");
  if (!status) return null;
  const token = typeof o.token === "string" ? o.token : await o.token();
  const c = claims(token);
  if (!c || c.def !== f.get("definition") || c.id !== f.get("id")) return null;
  const code = f.get("code") ?? "error";
  const completion = f.get("completion") ?? "";
  const nonceOf = f.get("nonce");
  // Read once: gone from the address bar and this history entry, so a reload or a third-party script finds nothing.
  for (const k of KEYS) f.delete(k);
  here.hash = f.toString();
  win.history.replaceState(win.history.state, "", here.href);
  let r: Result | null = null;
  if (status === "error") r = err(code, "");
  if (status === "connected") r = { status: "connected" };
  if (status === "authorized") r = await confirm(win, o.url, token, completion).catch((e: Error) => err("error", e.message));
  // A popup cut off by COOP lands here with no opener: tell the waiting connect() on the app's own channel.
  const n = nonceOf;
  if (r && n) {
    const bc = channel(win, n);
    bc?.postMessage({ type: "connectd", nonce: n, ...r });
    bc?.close();
  }
  if (r && win.name.startsWith("connectd-")) win.close();
  return r;
}
