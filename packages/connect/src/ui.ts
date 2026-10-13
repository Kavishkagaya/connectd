import { claims, type ConnectOptions, connect, type Result, resume, type SessionInfo, session, type Token } from "./connect.ts";

/**
 * The prebuilt UI (#29): a connect button, or a form for API-key definitions, rendered into `el`.
 * Unstyled markup with `oc-*` classes; style it, or build your own on `connect()`. Returns `unmount`.
 *
 *   const unmount = mount(document.getElementById("github")!, { url, token, onResult: (r) => ... });
 *
 * React: `useEffect(() => mount(ref.current!, opts), [])` (unmount is the cleanup).
 * On a return URL (redirect mode) it runs `resume()` first and reports that result.
 */
export type MountOptions = Omit<ConnectOptions, "fields" | "token"> & {
  token: Token;
  /** Button text. Default `Connect <definition>` (`Reconnect` once active). */
  label?: string;
  onResult?(r: Result): void;
};

const TEXT: Record<Result["status"], string> = { connected: "Connected.", closed: "The window was closed.", redirecting: "Redirecting…", error: "" };
// ponytail: definitions declare field names only; the input type is guessed. Add labels and types to `apiKey(fields)` when a provider needs them.
const SECRET = /key|secret|token|password/i;

export function mount(el: HTMLElement, o: MountOptions): () => void {
  const win = o.window ?? window;
  const doc = win.document;
  let live = true;
  // One token for the info call and the clicks, fetched again once it's close to expiring.
  let cached: string | null = typeof o.token === "string" ? o.token : null;
  const token = async () => {
    const exp = cached ? (claims(cached)?.exp ?? 0) : 0;
    if (!cached || (typeof o.token !== "string" && exp - Date.now() < 30_000)) cached = typeof o.token === "string" ? o.token : await o.token();
    return cached;
  };

  const root = doc.createElement("div");
  root.className = "oc-connect";
  const status = doc.createElement("p");
  status.className = "oc-status";
  status.setAttribute("aria-live", "polite");
  el.replaceChildren(root);

  const show = (r: Result) => {
    if (!live) return;
    status.textContent = r.status === "error" ? `Could not connect (${r.code}).` : TEXT[r.status];
    o.onResult?.(r);
  };

  function render(info: SessionInfo) {
    const button = doc.createElement("button");
    button.className = "oc-button";
    button.textContent = o.label ?? `${info.state === "active" ? "Reconnect" : "Connect"} ${info.definition}`;
    const run = (p: Promise<Result>) => {
      button.disabled = true;
      p.then((r) => {
        button.disabled = false;
        show(r);
      });
    };
    const opts = { ...o, token };
    if (info.flow === "redirect") {
      button.type = "button";
      // Synchronous in the click: connect() opens the popup before awaiting anything.
      button.addEventListener("click", () => run(connect(opts)));
      root.replaceChildren(button, status);
      return;
    }
    const form = doc.createElement("form");
    form.className = "oc-form";
    const inputs = info.fields.map((f) => {
      const label = doc.createElement("label");
      label.textContent = f;
      const input = doc.createElement("input");
      input.name = f;
      input.required = true;
      input.autocomplete = "off";
      input.type = SECRET.test(f) ? "password" : "text";
      label.appendChild(input);
      form.appendChild(label);
      return input;
    });
    button.type = "submit";
    form.appendChild(button);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      run(connect({ ...opts, fields: Object.fromEntries(inputs.map((i) => [i.name, i.value])) }));
    });
    root.replaceChildren(form, status);
  }

  token()
    .then(async (t) => {
      const back = await resume({ url: o.url, token: t, window: win });
      const info = await session({ url: o.url, token: t, window: win });
      if (!live) return;
      render(info);
      if (back) show(back);
    })
    .catch((e: Error & { code?: string }) => {
      root.replaceChildren(status);
      show({ status: "error", code: e.code ?? "error", message: e.message });
    });

  return () => {
    live = false;
    root.remove();
  };
}
