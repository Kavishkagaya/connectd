// The app's side, as a developer's app calls connectd: the SDK with CONNECTD_* from the env
// (`node --env-file=<file> app.mjs <expect>`). <expect>: the connections `list` must show, e.g.
// "github/alice:pending", or "" for none. Exits 1 on any mismatch.
import { connectd } from "@kavishkagaya/connectd/sdk";

const [expected = "github/alice:pending", start = "connect"] = process.argv.slice(2);
const oc = connectd();
let failed = 0;
const check = (name, ok, info = "") => (console.log(ok ? "PASS" : "FAIL", name, ok ? "" : info), ok || failed++);

if (start === "connect") {
  const { url } = await oc.connection("github", "alice").connect({ returnTo: "http://localhost:3000/done" });
  check("connect returns the provider's authorize URL", String(url).startsWith("https://github.com/login/oauth/authorize?"), url);
  const s = await oc.connection("github", "alice").status();
  check("status is pending until the user approves", s.state === "pending", JSON.stringify(s));
}
const rows = [];
for await (const r of oc.connections.list()) rows.push(`${r.def}/${r.id}:${r.state}`);
check(`connections list is "${expected}"`, rows.join(" ") === expected, rows.join(" "));
process.exit(failed ? 1 : 0);
