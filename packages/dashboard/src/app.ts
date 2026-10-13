import type { EventsStatus, EventSummary, Fault, Page, Row, WebhooksStatus } from "@openconnect/runtime";
import type { DefinitionInfo, Detail, Overview } from "./index.ts";

/**
 * The dashboard's browser side (#32): no framework, no dependency. Every node is built with
 * createElement and text nodes, never from an HTML string, so nothing from the API is parsed as markup.
 * Hash routes: `#/` connections (`?def=&state=&q=`), `#/c/<def>/<id>` one connection, `#/definitions`.
 *
 * The API key lives in sessionStorage (this tab only, gone when it closes) and goes out as a Bearer
 * header on same-origin fetches; it's never in a URL or a cookie.
 * ponytail: the tab holds the deployment's full API key; a scoped or expiring dashboard credential when teams share one (managed has users and roles).
 */

/** What it uses of `window`; a fake in tests. */
export type Win = Pick<Window, "document" | "location" | "sessionStorage" | "fetch" | "addEventListener" | "removeEventListener" | "confirm">;

export const KEY = "openconnect.dashboard.key";
const STATES = ["pending", "active", "reauth_required", "revoked"];
// ponytail: field types are guessed from names, as in @openconnect/connect's form.
const SECRET = /key|secret|token|password/i;

type Child = Node | string | null | undefined | false;
type Props = Record<string, string | boolean | ((e: Event) => void)>;

class ApiError extends Error {
  constructor(readonly fault: Fault) {
    super(`${fault.code}: ${fault.message}`);
  }
}

export function start(win: Win) {
  const doc = win.document;
  const root = doc.getElementById("app") as HTMLElement;
  let key = read();
  let info: Overview | null = null;
  let gen = 0;
  let work: Promise<unknown> = Promise.resolve();

  function read() {
    try {
      return win.sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  }
  function keep(k: string | null) {
    key = k;
    info = null;
    try {
      k === null ? win.sessionStorage.removeItem(KEY) : win.sessionStorage.setItem(KEY, k);
    } catch {}
  }

  function h(tag: string, props: Props = {}, ...kids: Child[]): HTMLElement {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else if (v !== false) el.setAttribute(k, v);
    }
    for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
    return el;
  }
  /** A link the API handed us: http(s) only, so a `javascript:` URL can't get in. */
  const out = (url: string, text: string) => (/^https?:\/\//i.test(url) ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, text) : text);
  const time = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : "—");
  const json = (v: unknown) => h("pre", {}, JSON.stringify(v, null, 2));
  const badge = (state: string) => h("span", { class: `oc-state oc-${state}` }, state);
  const table = (head: string[], rows: Child[][]) =>
    h("table", {}, h("thead", {}, h("tr", {}, ...head.map((x) => h("th", {}, x)))), h("tbody", {}, ...rows.map((r) => h("tr", {}, ...r.map((c) => h("td", {}, c))))));
  const dl = (pairs: [string, Child][]) => h("dl", {}, ...pairs.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
  const hash = (...parts: string[]) => `#/${parts.map(encodeURIComponent).join("/")}`;
  const connLink = (def: string, id: string) => h("a", { href: hash("c", def, id) }, id);

  async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const res = await win.fetch(path, {
      method,
      headers: { authorization: `Bearer ${key ?? ""}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const b = (await res.json().catch(() => null)) as { error?: Fault } | null;
    if (!res.ok) {
      const f = b?.error ?? { code: "http_error", status: res.status, message: `HTTP ${res.status}` };
      // A rotated key signs the tab out.
      if (res.status === 401 && f.code === "unauthorized") keep(null);
      throw new ApiError(f);
    }
    return b as T;
  }
  const method = (def: string, id: string, m: string, args: unknown = null) => api(`/connections/${encodeURIComponent(def)}/${encodeURIComponent(id)}/${m}`, "POST", args);
  const overview = async () => (info ??= await api<Overview>("/dashboard/api/overview"));
  const problem = (e: unknown) => h("p", { class: "oc-error", role: "alert" }, e instanceof Error ? e.message : String(e));

  /** Run `f` (a click, a submit), then draw the current route again with what it said. */
  function act(f: () => Promise<Child>) {
    return (e: Event) => {
      e.preventDefault();
      track(
        f().then(
          (note) => render(note ?? null),
          (err) => render(problem(err)),
        ),
      );
    };
  }
  function track<T>(p: Promise<T>) {
    work = Promise.all([work, p.catch(() => {})]);
    return p;
  }

  function login(note: Child) {
    const input = h("input", { type: "password", name: "key", autocomplete: "current-password", required: true, "aria-label": "API key" }) as HTMLInputElement;
    const submit = act(async () => {
      keep(input.value.trim());
      try {
        await overview();
      } catch (e) {
        keep(null);
        throw e instanceof ApiError && e.fault.status === 401 ? new Error("Wrong API key.") : e;
      }
      return null;
    });
    return h(
      "form",
      { class: "oc-login", onsubmit: submit },
      h("h1", {}, "openconnect"),
      h("label", {}, "API key ", input),
      h("button", { type: "submit" }, "Sign in"),
      note,
      h("p", { class: "oc-hint" }, "The deployment's OPENCONNECT_API_KEY. Kept in this tab only."),
    );
  }

  function frame(view: Node, note: Child): (Node | string)[] {
    const signOut = (e: Event) => (e.preventDefault(), keep(null), track(render(null)));
    return [
      h(
        "header",
        {},
        h("strong", {}, "openconnect"),
        h("nav", {}, h("a", { href: "#/" }, "Connections"), h("a", { href: "#/definitions" }, "Definitions")),
        h("button", { type: "button", onclick: signOut }, "Sign out"),
      ),
      note || "",
      view,
    ];
  }

  async function connections(q: URLSearchParams) {
    const o = await overview();
    const sel = (name: string, values: string[], current: string) =>
      h("select", { name, "aria-label": name }, h("option", { value: "" }, `any ${name}`), ...values.map((v) => h("option", { value: v, selected: v === current }, v))) as HTMLSelectElement;
    const def = sel("definition", o.definitions.map((d) => d.id), q.get("def") ?? "");
    const state = sel("state", STATES, q.get("state") ?? "");
    const search = h("input", { type: "search", name: "q", value: q.get("q") ?? "", placeholder: "id or external id", "aria-label": "search" }) as HTMLInputElement;
    const filter = (e: Event) => {
      e.preventDefault();
      const p = new URLSearchParams();
      for (const [k, v] of [["def", def.value], ["state", state.value], ["q", search.value.trim()]] as const) if (v) p.set(k, v);
      win.location.hash = `#/?${p}`;
    };
    const openDef = sel("definition", o.definitions.map((d) => d.id), "");
    const openId = h("input", { name: "id", required: true, placeholder: "connection id", "aria-label": "connection id" }) as HTMLInputElement;
    const open = h(
      "form",
      { class: "oc-open", onsubmit: (e: Event) => (e.preventDefault(), openDef.value && openId.value && (win.location.hash = hash("c", openDef.value, openId.value))) },
      "Open or start a connection: ",
      openDef,
      openId,
      h("button", { type: "submit" }, "Open"),
    );
    if (!o.index) return h("section", {}, h("h2", {}, "Connections"), h("p", {}, "No connection index (directory) in this deployment: listing and search need it."), open);

    const body = h("tbody");
    const more = h("p");
    const page = async (cursor: string | null) => {
      const p = new URLSearchParams(q);
      if (cursor) p.set("cursor", cursor);
      const r = await api<Page>(`/connections?${p}`);
      body.append(
        ...r.connections.map((c: Row) =>
          h(
            "tr",
            {},
            h("td", {}, c.def),
            h("td", {}, connLink(c.def, c.id)),
            h("td", {}, badge(c.state)),
            h("td", {}, c.reason ?? ""),
            h("td", {}, Object.entries(c.external).map(([k, v]) => `${k}=${v}`).join(" ")),
            h("td", {}, time(c.updatedAt)),
          ),
        ),
      );
      // Appends in place: `act` would redraw the route from the first page.
      const next = (e: Event) => (e.preventDefault(), track(page(r.cursor).catch((err) => more.replaceChildren(problem(err)))));
      more.replaceChildren(r.cursor ? h("button", { type: "button", onclick: next }, "Load more") : r.connections.length || cursor ? "" : "No connections.");
    };
    await page(null);
    return h(
      "section",
      {},
      h("h2", {}, "Connections"),
      h("form", { class: "oc-filter", onsubmit: filter }, def, state, search, h("button", { type: "submit" }, "Filter")),
      h("table", {}, h("thead", {}, h("tr", {}, ...["Definition", "ID", "State", "Reason", "External ids", "Updated"].map((x) => h("th", {}, x)))), body),
      more,
      open,
    );
  }

  function eventRows(list: EventSummary[], redeliver?: (slot: number) => (e: Event) => void) {
    return list.map((e) => [
      String(e.slot),
      e.id,
      e.type,
      time(e.at),
      e.type === "webhook" ? `${(e.data as { topic?: string }).topic ?? ""}` : JSON.stringify(e.data),
      redeliver ? h("button", { type: "button", onclick: redeliver(e.slot) }, "Redeliver") : "",
    ]);
  }

  async function connection(def: string, id: string) {
    const o = await overview();
    const d: DefinitionInfo | undefined = o.definitions.find((x) => x.id === def);
    if (!d) throw new Error(`No definition ${def} in this deployment.`);
    const x = await api<Detail>(`/dashboard/api/connections/${encodeURIComponent(def)}/${encodeURIComponent(id)}`);
    const st = "ok" in x.status ? (x.status.ok as { state: string; reason?: string; metadata: unknown }) : null;
    const missing = "error" in x.status && x.status.error.code === "not_found";
    const parts: Child[] = [h("h2", {}, `${def} / `, h("code", {}, id))];

    if (st) parts.push(dl([["State", badge(st.state)], ["Reason", st.reason ?? "—"], ["External ids", x.external ? Object.entries(x.external).map(([k, v]) => `${k}=${v}`).join(" ") || "—" : "—"]]), h("h3", {}, "Metadata"), json(st.metadata));
    else parts.push(missing ? h("p", {}, "No connection with this id yet.") : problem(new ApiError((x.status as { error: Fault }).error)));

    // Actions. Connect on an existing connection re-authorizes it; a revoked one is terminal.
    const actions = h("div", { class: "oc-actions" });
    if (st && st.state !== "revoked")
      actions.append(
        h(
          "button",
          {
            type: "button",
            class: "oc-danger",
            onclick: act(async () => {
              if (!win.confirm(`Revoke ${def} / ${id}? This is terminal: reconnecting makes a new connection.`)) return null;
              await method(def, id, "revoke", { reason: "dashboard" });
              return h("p", { class: "oc-note" }, "Revoked.");
            }),
          },
          "Revoke",
        ),
      );
    if (st && o.index) actions.append(h("button", { type: "button", onclick: act(async () => (await method(def, id, "index.sync"), h("p", { class: "oc-note" }, "Index row re-copied."))) }, "Sync index"));
    actions.append(h("button", { type: "button", onclick: act(async () => null) }, "Refresh"));
    parts.push(actions);
    if (st?.state !== "revoked") parts.push(connect(d, id, !!st));

    // Events outbox.
    parts.push(h("h3", {}, "Events"));
    if ("error" in x.events) parts.push(h("p", {}, `Not available (${x.events.error.code}): no events() extension?`));
    else {
      const ev = x.events.ok as unknown as EventsStatus;
      if (!ev.enabled) parts.push(h("p", { class: "oc-hint" }, "Event delivery is off (no events URL in the config)."));
      parts.push(
        dl([
          ["Pending", String(ev.pending)],
          ["Attempt", String(ev.attempt)],
          ["Next retry", time(ev.retryAt)],
          ["Last error", ev.error ?? "—"],
        ]),
      );
      if (ev.enabled && ev.pending)
        parts.push(h("button", { type: "button", onclick: act(async () => (await method(def, id, "events.flush"), h("p", { class: "oc-note" }, "Delivery started; refresh to see it."))) }, "Deliver now"));
      if (ev.queued.length) parts.push(h("h4", {}, "Queued (head first)"), table(["Slot", "Id", "Type", "At", "Data", ""], eventRows(ev.queued)));
      const again = (slot: number) =>
        act(async () => {
          const r = await method(def, id, "events.redeliver", { slot });
          return h("p", { class: "oc-note" }, `Queued again as slot ${(r as { slot: number }).slot}, same webhook-id.`);
        });
      if (ev.recent.length) parts.push(h("h4", {}, "Recent (newest first)"), table(["Slot", "Id", "Type", "At", "Data", ""], eventRows(ev.recent, ev.enabled ? again : undefined)));
    }

    // Provider webhooks.
    parts.push(h("h3", {}, "Webhooks"));
    if ("error" in x.webhooks) parts.push(h("p", {}, `Not available (${x.webhooks.error.code}): no webhooks() extension?`));
    else {
      const w = x.webhooks.ok as unknown as WebhooksStatus;
      if (!w.supported) parts.push(h("p", {}, "This definition takes no webhooks."));
      else
        parts.push(
          dl([
            ["Ingress URL", w.url ?? "— (no webhooks settings)"],
            ["Auto-registers", w.registers ? "yes" : "no"],
            ["Registration", w.registration ? json(w.registration.hook) : "none"],
            ["Renews at", time(w.registration?.renewAt)],
            ["Registering", w.pending ? "armed or retrying" : "no"],
          ]),
        );
    }
    return h("section", {}, ...parts);
  }

  /**
   * Start or re-authorize: API-key fields go to `connect`; an OAuth definition gets the provider's URL to open.
   * ponytail: that URL isn't bound to a browser (#28); a session-based connect (#29) needs this origin in `sessions.origins`.
   */
  function connect(d: DefinitionInfo, id: string, exists: boolean) {
    const title = h("h3", {}, exists ? "Re-authorize" : "Connect");
    if (!d.configured) return h("div", {}, title, h("p", {}, `${d.id} has no connector config: it answers not_configured.`));
    if (d.flow === "form") {
      const inputs = d.fields.map((f) => h("input", { name: f, type: SECRET.test(f) ? "password" : "text", autocomplete: "off", required: true, "aria-label": f }) as HTMLInputElement);
      const submit = act(async () => {
        await method(d.id, id, "connect", Object.fromEntries(d.fields.map((f, i) => [f, (inputs[i] as HTMLInputElement).value])));
        return h("p", { class: "oc-note" }, "Connected.");
      });
      return h("form", { class: "oc-connect", onsubmit: submit }, title, ...d.fields.map((f, i) => h("label", {}, `${f} `, inputs[i])), h("button", { type: "submit" }, exists ? "Re-authorize" : "Connect"));
    }
    const go = act(async () => {
      const { url } = (await method(d.id, id, "connect")) as { url: string | null };
      if (!url) return h("p", { class: "oc-note" }, "Connected.");
      return h("p", { class: "oc-note" }, out(url, "Open the provider's authorization page"), " (new tab; it finishes at /callback, then refresh here).");
    });
    return h("div", {}, title, h("button", { type: "button", onclick: go }, `Get an authorization link for ${d.id}`));
  }

  async function definitions() {
    const o = await overview();
    const config = (d: DefinitionInfo) => (!d.configured ? "missing: not_configured" : d.missing.length ? `empty: ${d.missing.join(", ")}` : d.flow === "form" ? "not needed" : "set");
    return h(
      "section",
      {},
      h("h2", {}, "Deployment"),
      dl([
        ["Callback URL", h("code", {}, o.callbackUrl)],
        ["Webhooks", o.webhooks ? h("code", {}, `${o.webhooks.url}/:def[/:id]`) : "off"],
        ["Events", o.events ? h("code", {}, o.events.url) : "off"],
        ["Sessions", o.sessions ? o.sessions.origins.join(", ") || "no origins" : "off"],
        ["Index", o.index ? "on" : "off"],
      ]),
      h("p", { class: "oc-hint" }, "Register the callback URL as the redirect URI with each OAuth provider."),
      h("h2", {}, "Definitions"),
      table(
        ["Id", "Flow", "Config", "Proxy", "Webhook URLs"],
        o.definitions.map((d) => [
          h("a", { href: `#/?def=${encodeURIComponent(d.id)}` }, d.id),
          d.flow === "form" ? `form (${d.fields.join(", ")})` : "redirect",
          h("span", { class: d.configured && !d.missing.length ? "" : "oc-warn" }, config(d)),
          d.proxy ? h("code", {}, d.proxy) : "—",
          d.webhooks ? h("div", {}, h("code", {}, d.webhooks.app), h("br"), h("code", {}, d.webhooks.connection), d.webhooks.registers ? " (registered per connection)" : "") : "—",
        ]),
      ),
    );
  }

  /** Draw the route in the hash. `note` is shown above it (an action's result or error). */
  async function render(note: Child): Promise<void> {
    const mine = ++gen;
    if (!key) return void root.replaceChildren(login(note));
    const [path = "", query = ""] = win.location.hash.replace(/^#\/?/, "").split("?");
    const [view, ...args] = path.split("/").filter(Boolean).map(decodeURIComponent);
    let node: Node;
    try {
      node = view === "c" && args.length === 2 ? await connection(args[0]!, args[1]!) : view === "definitions" ? await definitions() : await connections(new URLSearchParams(query));
    } catch (e) {
      if (!key) return void (mine === gen && root.replaceChildren(login(problem(e))));
      node = problem(e);
    }
    // A newer render (another click, a hash change) won.
    if (mine === gen) root.replaceChildren(...frame(node, note));
  }

  const onHash = () => void track(render(null));
  win.addEventListener("hashchange", onHash);
  track(render(null));
  return {
    /** Resolves once every render and action started so far has finished (tests). */
    async idle() {
      for (let w = work; ; w = work) {
        await w;
        if (w === work) return;
      }
    },
    stop: () => win.removeEventListener("hashchange", onHash),
  };
}
