import type { EventsStatus, EventSummary, Fault, Page, Row, Subscription, WebhooksStatus } from "@kavishkagaya/connectd-runtime";
import type { ActionInfo, DefinitionInfo, Detail, Failures, Overview } from "./index.ts";

/**
 * The dashboard's browser side (#32): no framework, no dependency. Every node is built with
 * createElement and text nodes, never from an HTML string, so nothing from the API is parsed as markup.
 * Hash routes: `#/` connections (`?def=&state=&q=`), `#/c/<def>/<id>` one connection, `#/actions`
 * (every action, recent failures; `?def=`), `#/definitions`.
 *
 * The API key lives in sessionStorage (this tab only, gone when it closes) and goes out as a Bearer
 * header on same-origin fetches; it's never in a URL or a cookie.
 * ponytail: the tab holds the deployment's full API key; a scoped or expiring dashboard credential when teams share one (managed has users and roles).
 */

/** What it uses of `window`; a fake in tests. */
export type Win = Pick<Window, "document" | "location" | "sessionStorage" | "fetch" | "addEventListener" | "removeEventListener" | "confirm">;

export const KEY = "connectd.dashboard.key";

/** Usable as a path segment: not empty, `.` or `..`. */
export const addressable = (s: string) => s !== "" && s !== "." && s !== "..";
function address(args: string[]): [string, string] {
  const [def = "", id = "", ...rest] = args;
  if (rest.length || !addressable(def) || !addressable(id)) throw new Error(`Not a connection address: definition and id can't be empty, "." or "..".`);
  return [def, id];
}
const STATES = ["pending", "active", "reauth_required", "revoked"];
// ponytail: field types are guessed from names, as in @kavishkagaya/connectd-connect's form.
const SECRET = /key|secret|token|password/i;

/** `10 min`, `1 h`, `90 s`. */
export function every(ms: number) {
  for (const [unit, n] of [["d", 86_400_000], ["h", 3_600_000], ["min", 60_000], ["s", 1000]] as const) if (ms >= n && ms % n === 0) return `${ms / n} ${unit}`;
  return `${ms} ms`;
}
const trigger = (a: Pick<ActionInfo, "every" | "on">) => (a.every !== null ? `every ${every(a.every)}` : a.on !== null ? `on ${a.on}` : "called by the app");

type Field = { name: string; kind: "string" | "number" | "integer" | "boolean" | "enum"; options: string[]; required: boolean; description: string };
/**
 * The fields of a flat object schema (strings, numbers, booleans, string enums), or null when it's
 * anything else: then the form is a JSON text box. The runtime checks the input either way.
 */
export function fields(schema: unknown): Field[] | null {
  const s = schema as { type?: unknown; properties?: Record<string, unknown>; required?: unknown } | null;
  if (!s || s.type !== "object" || !s.properties || typeof s.properties !== "object") return null;
  const required = Array.isArray(s.required) ? s.required : [];
  const out: Field[] = [];
  for (const [name, raw] of Object.entries(s.properties)) {
    const p = raw as { type?: unknown; enum?: unknown; description?: unknown } | null;
    if (!p || typeof p !== "object") return null;
    const description = typeof p.description === "string" ? p.description : "";
    if (Array.isArray(p.enum) && p.enum.length && p.enum.every((v) => typeof v === "string")) out.push({ name, kind: "enum", options: p.enum as string[], required: required.includes(name), description });
    else if (p.type === "string" || p.type === "number" || p.type === "integer" || p.type === "boolean") out.push({ name, kind: p.type, options: [], required: required.includes(name), description });
    else return null;
  }
  return out;
}

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
  /**
   * A path segment from a definition or connection id. `.`, `..` and empty would be collapsed by URL
   * parsing (`/connections/keyed/../x`) and reach another route, so they're refused, as in the SDK (#28).
   */
  const seg = (s: string) => {
    if (!addressable(s)) throw new Error(`Not a connection address: "${s}" (definition and id can't be empty, "." or "..").`);
    return encodeURIComponent(s);
  };
  const method = (def: string, id: string, m: string, args: unknown = null) => api(`/connections/${seg(def)}/${seg(id)}/${m}`, "POST", args);
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
      h("h1", {}, "connectd"),
      h("label", {}, "API key ", input),
      h("button", { type: "submit" }, "Sign in"),
      note,
      h("p", { class: "oc-hint" }, "The deployment's CONNECTD_API_KEY. Kept in this tab only."),
    );
  }

  function frame(view: Node, note: Child): (Node | string)[] {
    const signOut = (e: Event) => (e.preventDefault(), keep(null), track(render(null)));
    return [
      h(
        "header",
        {},
        h("strong", {}, "connectd"),
        h("nav", {}, h("a", { href: "#/" }, "Connections"), h("a", { href: "#/actions" }, "Actions"), h("a", { href: "#/definitions" }, "Definitions")),
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
      e.type.startsWith("webhook.") ? `${(e.data as { topic?: string }).topic ?? ""}` : JSON.stringify(e.data),
      `${e.size} B${e.copy ? ", redelivered copy" : ""}${e.dropped ? ", dropped" : e.deliveredAt ? `, delivered ${time(e.deliveredAt)}` : ""}`,
      redeliver && e.redeliverable ? h("button", { type: "button", onclick: redeliver(e.slot) }, "Redeliver") : redeliver ? "body not kept" : "",
    ]);
  }

  async function connection(def: string, id: string) {
    const o = await overview();
    const d: DefinitionInfo | undefined = o.definitions.find((x) => x.id === def);
    if (!d) throw new Error(`No definition ${def} in this deployment.`);
    const x = await api<Detail>(`/dashboard/api/connections/${seg(def)}/${seg(id)}`);
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

    if (d.actions.length) parts.push(...actionsPanel(d, id, x));

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
      if (ev.queued.length) parts.push(h("h4", {}, "Queued (head first)"), table(["Slot", "Id", "Type", "At", "Data", "Size", ""], eventRows(ev.queued)));
      const again = (slot: number) =>
        act(async () => {
          const r = await method(def, id, "events.redeliver", { slot });
          return h("p", { class: "oc-note" }, `Queued again as slot ${(r as { slot: number }).slot}, same webhook-id.`);
        });
      if (ev.recent.length) parts.push(h("h4", {}, "Recent (newest first)"), table(["Slot", "Id", "Type", "At", "Data", "Delivery", ""], eventRows(ev.recent, ev.enabled ? again : undefined)));
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
    if (x.subscriptions) parts.push(...subscriptionsPanel(def, id, x.subscriptions));
    return h("section", {}, ...parts);
  }

  /** The latest kept `<action>.completed` / `.failed` of each action, from the connection's events. */
  function lastRuns(d: DefinitionInfo, events: Detail["events"]) {
    const out = new Map<string, EventSummary>();
    if (!("ok" in events)) return out;
    const ev = events.ok as unknown as EventsStatus;
    // Matched against the action names: a webhook topic can end in `.failed` too (`webhook.charge.failed`).
    const ids = new Set(d.actions.map((a) => a.id));
    for (const e of [...ev.queued, ...ev.recent]) {
      const m = /^(.+)\.(completed|failed)$/.exec(e.type);
      if (!m || e.copy || !ids.has(m[1] as string)) continue;
      const prev = out.get(m[1] as string);
      if (!prev || e.at > prev.at) out.set(m[1] as string, e);
    }
    return out;
  }

  /** Each action: trigger, next run, last scheduled result, and a form to run it now. */
  function actionsPanel(d: DefinitionInfo, id: string, x: Detail): Child[] {
    const status = x.actions && "ok" in x.actions ? (x.actions.ok as { id: string; next: number | null }[]) : [];
    const next = new Map(status.map((a) => [a.id, a.next]));
    const last = lastRuns(d, x.events);
    const result = (a: ActionInfo) => {
      const e = last.get(a.id);
      if (!e) return a.every !== null || a.on !== null ? "none kept" : "—";
      const data = e.data as { error?: string; attempt?: number };
      return e.type.endsWith(".failed")
        ? h("span", { class: "oc-warn" }, `failed ${time(e.at)}: ${data.error ?? ""}${data.attempt ? ` (attempt ${data.attempt})` : ""}`)
        : `ok ${time(e.at)}`;
    };
    const out: Child[] = [
      h("h3", {}, "Actions"),
      table(
        ["Action", "Trigger", "Next run", "Last scheduled run"],
        d.actions.map((a) => [h("code", {}, a.id), trigger(a), a.every !== null ? time(next.get(a.id)) : "—", result(a)]),
      ),
    ];
    if (x.actions && "error" in x.actions) out.push(problem(new ApiError(x.actions.error)));
    out.push(...d.actions.map((a) => runForm(d.id, id, a)));
    return out;
  }

  /** Run an action now, with its input from a form built from its JSON Schema, or a JSON text box. */
  function runForm(def: string, id: string, a: ActionInfo) {
    const list = a.input ? fields(a.schema) : [];
    let read: () => unknown;
    const kids: Child[] = [];
    if (list === null) {
      const text = h("textarea", { name: "input", rows: "4", "aria-label": `${a.id} input (JSON)`, placeholder: "{}" }) as HTMLTextAreaElement;
      kids.push(h("label", {}, "Input (JSON) ", text));
      read = () => {
        try {
          return text.value.trim() ? JSON.parse(text.value) : null;
        } catch {
          throw new Error("The input is not valid JSON.");
        }
      };
    } else {
      const inputs = list.map((f) => {
        const el =
          f.kind === "enum"
            ? h("select", { name: f.name, "aria-label": f.name }, ...(f.required ? [] : [h("option", { value: "" }, "—")]), ...f.options.map((o) => h("option", { value: o }, o)))
            : h("input", { name: f.name, "aria-label": f.name, type: f.kind === "boolean" ? "checkbox" : f.kind === "string" ? "text" : "number", ...(f.kind === "integer" ? { step: "1" } : {}), required: f.required && f.kind !== "boolean" });
        kids.push(h("label", {}, `${f.name} `, el, f.description ? h("span", { class: "oc-hint" }, ` ${f.description}`) : null));
        return el as HTMLInputElement;
      });
      read = () =>
        Object.fromEntries(
          list.flatMap((f, i): [string, string | number | boolean][] => {
            const el = inputs[i] as HTMLInputElement;
            if (f.kind === "boolean") return [[f.name, !!el.checked]];
            if (el.value === "") return [];
            return [[f.name, f.kind === "number" || f.kind === "integer" ? Number(el.value) : el.value]];
          }),
        );
    }
    const submit = act(async () => {
      const out = await method(def, id, `actions/${seg(a.id)}`, a.input ? read() : null);
      return h("div", { class: "oc-note" }, `${a.id} returned:`, json(out));
    });
    return h("details", { class: "oc-run" }, h("summary", {}, `Run ${a.id}`), h("form", { onsubmit: submit }, ...kids, h("button", { type: "submit" }, `Run ${a.id} now`)));
  }

  function subscriptionsPanel(def: string, id: string, r: NonNullable<Detail["subscriptions"]>): Child[] {
    const title = h("h4", {}, "Subscriptions");
    if ("error" in r) return [title, problem(new ApiError(r.error))];
    const list = r.ok as unknown as Subscription[];
    if (!list.length) return [title, h("p", {}, "None. The app adds them with webhooks.subscribe().")];
    const drop = (s: Subscription) =>
      act(async () => {
        if (!win.confirm(`Unsubscribe ${s.id}? It's removed at the provider too.`)) return null;
        await method(def, id, "webhooks.unsubscribe", { id: s.id });
        return h("p", { class: "oc-note" }, "Unsubscribed.");
      });
    return [title, table(["Id", "Input", "Renews at", ""], list.map((s) => [h("code", {}, s.id), json(s.input), time(s.renewAt), h("button", { type: "button", class: "oc-danger", onclick: drop(s) }, "Unsubscribe")]))];
  }

  /** Every action of the deployment, and recent failed scheduled runs across connections. */
  async function actionsView(q: URLSearchParams) {
    const o = await overview();
    const all = o.definitions.flatMap((d) => d.actions.map((a) => ({ def: d.id, a })));
    const parts: Child[] = [h("h2", {}, "Actions")];
    if (!all.length) return h("section", {}, ...parts, h("p", {}, "No actions in this deployment. Add one as src/oc/<connection>/actions/<name>.ts."));
    parts.push(table(["Connection", "Action", "Trigger", "Input"], all.map(({ def, a }) => [def, h("code", {}, a.id), trigger(a), a.input ? (a.schema ? "schema" : "yes") : "none"])));
    parts.push(h("h3", {}, "Recent failures"));
    if (!o.index) return h("section", {}, ...parts, h("p", {}, "Needs a connection index (directory) to look across connections."));
    const defs = [...new Set(all.map((x) => x.def))];
    const current = q.get("def") ?? "";
    const pick = h("select", { name: "def", "aria-label": "definition" }, h("option", { value: "" }, "any definition"), ...defs.map((v) => h("option", { value: v, selected: v === current }, v))) as HTMLSelectElement;
    const filter = (e: Event) => {
      e.preventDefault();
      win.location.hash = pick.value ? `#/actions?def=${encodeURIComponent(pick.value)}` : "#/actions";
    };
    parts.push(h("form", { class: "oc-filter", onsubmit: filter }, pick, h("button", { type: "submit" }, "Filter")));
    const f = await api<Failures>(`/dashboard/api/failures${current ? `?def=${encodeURIComponent(current)}` : ""}`);
    parts.push(
      f.failures.length
        ? table(["At", "Connection", "Action", "Error", "Attempt"], f.failures.map((x) => [time(x.at), h("span", {}, `${x.def} / `, connLink(x.def, x.id)), h("code", {}, x.action), x.error, String(x.attempt)]))
        : h("p", {}, "No failed runs in the kept events."),
      h("p", { class: "oc-hint" }, `Looked at ${f.scanned} connection${f.scanned === 1 ? "" : "s"}${f.more ? " (the first ones in the index; filter by definition to narrow it)" : ""}, from each one's kept events.`),
    );
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
    let node: Node;
    try {
      // Empty segments kept (`#/c//x`), so the connection route can refuse them. A bad escape throws here too.
      const [view, ...args] = path.split("/").map(decodeURIComponent);
      node = view === "c" ? await connection(...address(args)) : view === "definitions" ? await definitions() : view === "actions" ? await actionsView(new URLSearchParams(query)) : await connections(new URLSearchParams(query));
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
