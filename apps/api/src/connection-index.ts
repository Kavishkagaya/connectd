import type { Env } from "./env";

type IndexRow = {
  doName: string;
  teamId: string;
  provider: string;
  tenantId: string;
  status: "active" | "revoked" | "needs_reauth";
  scopes: string[];
};

export async function upsertConnectionIndex(
  env: Env,
  row: IndexRow
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO connections (do_name, team_id, provider, tenant_id, status, scopes, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
     ON CONFLICT(do_name) DO UPDATE SET status = ?5, scopes = ?6, updated_at = ?7`
  )
    .bind(
      row.doName,
      row.teamId,
      row.provider,
      row.tenantId,
      row.status,
      row.scopes.join(","),
      now
    )
    .run();
}

export async function updateConnectionStatus(
  env: Env,
  doName: string,
  status: IndexRow["status"]
): Promise<void> {
  await env.DB.prepare(
    "UPDATE connections SET status = ?1, updated_at = ?2 WHERE do_name = ?3"
  )
    .bind(status, Date.now(), doName)
    .run();
}
