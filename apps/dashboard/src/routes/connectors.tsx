import { useEffect, useState } from "react";
import { useApi } from "../use-api";

export function ConnectorsPage() {
  const api = useApi();
  const [providers, setProviders] = useState<string[]>([]);
  const [provider, setProvider] = useState("github");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("");

  useEffect(() => {
    api.listConnectors().then((res) => setProviders(res.providers));
  }, [api]);

  async function onCreate(event: React.FormEvent) {
    event.preventDefault();
    await api.putConnector(provider, { clientId, clientSecret, redirectUri });
    setProviders(await api.listConnectors().then((res) => res.providers));
  }

  return (
    <section>
      <h1>Connectors</h1>
      <ul>
        {providers.map((p) => (
          <li key={p}>
            {p}{" "}
            <button
              onClick={async () => {
                await api.deleteConnector(p);
                setProviders((prev) => prev.filter((x) => x !== p));
              }}
              type="button"
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={onCreate}>
        <select onChange={(e) => setProvider(e.target.value)} value={provider}>
          <option value="github">GitHub</option>
          <option value="slack">Slack</option>
          <option value="google">Google</option>
        </select>
        <input
          onChange={(e) => setClientId(e.target.value)}
          placeholder="Client ID"
          value={clientId}
        />
        <input
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder="Client secret"
          type="password"
          value={clientSecret}
        />
        <input
          onChange={(e) => setRedirectUri(e.target.value)}
          placeholder="Redirect URI"
          value={redirectUri}
        />
        <button type="submit">Add connector</button>
      </form>
    </section>
  );
}
