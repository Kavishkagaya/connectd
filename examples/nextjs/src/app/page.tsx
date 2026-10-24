import { ConnectdError } from "@connectd/sdk";
import { disconnect, signIn, signOut } from "./actions";
import { currentUser, oc } from "../lib/oc";

type Repo = { full_name: string; html_url: string; private: boolean };

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const user = await currentUser();
  if (!user)
    return (
      <main>
        <h1>connectd + Next.js</h1>
        <form action={signIn}>
          <p>Sign in with any name (a demo stand-in for your app's auth):</p>
          <input name="name" placeholder="alice" required /> <button type="submit">Sign in</button>
        </form>
      </main>
    );

  const gh = oc.connection("github", user);
  const status = await gh.status().catch((e) => (e instanceof ConnectdError ? { state: e.code, reason: e.message, metadata: null } : Promise.reject(e)));
  let repos: Repo[] = [];
  let reposError = "";
  if (status.state === "active") {
    const res = await gh.fetch("/user/repos?sort=updated&per_page=20");
    if (res.ok) repos = (await res.json()) as Repo[];
    else reposError = `${res.status} ${await res.text()}`;
  }

  return (
    <main>
      <h1>connectd + Next.js</h1>
      <p>
        Signed in as <b>{user}</b>.{" "}
        <form action={signOut} style={{ display: "inline" }}>
          <button type="submit">Sign out</button>
        </form>
      </p>
      {q.connectd === "error" && <p style={{ color: "crimson" }}>Connecting failed: {q.code}</p>}

      <h2>GitHub</h2>
      <p>
        State: <code>{status.state}</code>
        {status.reason ? ` (${status.reason})` : ""}
      </p>
      {status.state === "active" ? (
        <>
          <p>
            Connected as <b>{String((status.metadata as { login?: string } | null)?.login ?? "?")}</b>.
          </p>
          <form action={disconnect}>
            <button type="submit">Disconnect</button>
          </form>
          <h3>Your recently updated repositories</h3>
          {reposError ? (
            <pre>{reposError}</pre>
          ) : repos.length ? (
            <ul>
              {repos.map((r) => (
                <li key={r.full_name}>
                  <a href={r.html_url}>{r.full_name}</a>
                  {r.private ? " (private)" : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p>No repositories.</p>
          )}
        </>
      ) : (
        <p>
          <a href="/api/connectd/connect/github?return=/">Connect GitHub</a>
        </p>
      )}
    </main>
  );
}
