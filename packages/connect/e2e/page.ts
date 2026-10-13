import { connect, mount, resume } from "../src/index.ts";

// The app's page in the e2e check: served with `Referrer-Policy: no-referrer` (helmet's default).
const RT = "http://localhost:8788";
const out = document.getElementById("out")!;
const get = async (q: string) => ((await (await fetch(`/token?${q}`)).json()) as { token: string }).token;
// Who is logged in to the app: a real app knows its user; this one takes the return URL's `id`
// unless a user was set (the CSRF check logs the victim in as v1, whatever the URL says).
const here = new URL(location.href).searchParams;
const user = localStorage.getItem("user") ?? here.get("id") ?? "r1";
const r = await resume({ url: RT, token: () => get(`def=${here.get("def") ?? "example"}&id=${user}&return=1`) });
if (r) out.textContent = "redirect:" + JSON.stringify(r);
const popupToken = await get("def=example&id=p1");
const redirToken = await get("def=example&id=r1&return=1");
const show = (name: string) => (x: unknown) => (out.textContent = `${name}:${JSON.stringify(x)}`);
document.getElementById("popup")!.onclick = () => connect({ url: RT, token: popupToken }).then(show("popup"));
document.getElementById("lazy")!.onclick = () => connect({ url: RT, token: () => get("def=example&id=l1") }).then(show("lazy"));
// A connection that isn't active yet (closing the popup on an active one still reads as connected).
document.getElementById("fresh")!.onclick = () => connect({ url: RT, token: () => get(`def=example&id=f${Date.now()}`) }).then(show("fresh"));
document.getElementById("coop")!.onclick = () => connect({ url: RT, token: () => get("def=coopy&id=c1&return=1") }).then(show("coop"));
document.getElementById("redir")!.onclick = () => connect({ url: RT, token: redirToken, mode: "redirect" });
mount(document.getElementById("ui")!, { url: RT, token: () => get("def=keyed&id=k1"), onResult: show("form") });
