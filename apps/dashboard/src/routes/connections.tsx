import { useEffect, useState } from "react";
import { useApi } from "../use-api";

type Connection = {
  do_name: string;
  provider: string;
  tenant_id: string;
  status: string;
  scopes: string;
  created_at: number;
};

export function ConnectionsPage() {
  const api = useApi();
  const [connections, setConnections] = useState<Connection[]>([]);

  useEffect(() => {
    api.listConnections().then((res) => setConnections(res.connections));
  }, [api]);

  return (
    <section>
      <h1>Connections</h1>
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Tenant</th>
            <th>Status</th>
            <th>Scopes</th>
          </tr>
        </thead>
        <tbody>
          {connections.map((c) => (
            <tr key={c.do_name}>
              <td>{c.provider}</td>
              <td>{c.tenant_id}</td>
              <td>{c.status}</td>
              <td>{c.scopes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
