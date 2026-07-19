type Connector = { provider: string };
type ApiKey = { id: string; key?: string };
type Connection = {
  do_name: string;
  provider: string;
  tenant_id: string;
  status: string;
  scopes: string;
  created_at: number;
};

async function call<T>(
  getToken: () => Promise<string | null>,
  path: string,
  init?: RequestInit
): Promise<T> {
  const token = await getToken();
  const response = await fetch(path, {
    ...init,
    headers: { ...init?.headers, authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return response.json();
}

export function createApiClient(getToken: () => Promise<string | null>) {
  return {
    listConnectors: () =>
      call<{ providers: string[] }>(getToken, "/management/connectors"),
    putConnector: (provider: string, body: Omit<Connector, "provider">) =>
      call(getToken, `/management/connectors/${provider}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    deleteConnector: (provider: string) =>
      call(getToken, `/management/connectors/${provider}`, {
        method: "DELETE",
      }),
    listConnections: () =>
      call<{ connections: Connection[] }>(getToken, "/management/connections"),
    createApiKey: () =>
      call<ApiKey>(getToken, "/management/api-keys", { method: "POST" }),
    revokeApiKey: (id: string) =>
      call(getToken, `/management/api-keys/${id}`, { method: "DELETE" }),
  };
}
