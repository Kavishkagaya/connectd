import { connect, mount, readResult } from "../src/index.ts";
const RT = "http://localhost:8788";
const out = document.getElementById("out")!;
const get = async (q: string) => ((await (await fetch(`/token?${q}`)).json()) as { token: string }).token;
const popupToken = await get("def=example&id=p1");
const redirToken = await get("def=example&id=r1&return=1");
const r = readResult();
if (r) out.textContent = "redirect:" + JSON.stringify(r);
document.getElementById("popup")!.onclick = () => connect({ url: RT, token: popupToken }).then((x) => (out.textContent = "popup:" + JSON.stringify(x)));
document.getElementById("lazy")!.onclick = () =>
  connect({ url: RT, token: () => get("def=example&id=l1") }).then((x) => (out.textContent = "lazy:" + JSON.stringify(x)));
document.getElementById("redir")!.onclick = () => connect({ url: RT, token: redirToken, mode: "redirect" });
mount(document.getElementById("ui")!, { url: RT, token: () => get("def=keyed&id=k1"), onResult: (x) => (out.textContent = "form:" + JSON.stringify(x)) });
