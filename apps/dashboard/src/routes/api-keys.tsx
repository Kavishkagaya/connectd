import { useState } from "react";
import { useApi } from "../use-api";

export function ApiKeysPage() {
  const api = useApi();
  const [createdKeys, setCreatedKeys] = useState<
    { id: string; key?: string }[]
  >([]);

  async function onCreate() {
    const created = await api.createApiKey();
    setCreatedKeys((prev) => [...prev, created]);
  }

  return (
    <section>
      <h1>API Keys</h1>
      <p>Keys are shown once, right after creation — copy them now.</p>
      <ul>
        {createdKeys.map((k) => (
          <li key={k.id}>
            <code>{k.key ?? k.id}</code>{" "}
            <button
              onClick={async () => {
                await api.revokeApiKey(k.id);
                setCreatedKeys((prev) => prev.filter((x) => x.id !== k.id));
              }}
              type="button"
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
      <button onClick={onCreate} type="button">
        Create API key
      </button>
    </section>
  );
}
