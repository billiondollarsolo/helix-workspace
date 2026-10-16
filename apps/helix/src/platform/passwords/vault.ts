import type { PasswordVaultResponse } from "@helix/contracts";
import type postgres from "postgres";

interface VaultRow {
  version: string;
  ciphertext: Buffer;
  previous_ciphertext: Buffer | null;
  previous_updated_at: Date | null;
  updated_at: Date;
}

export class PostgresPasswordVaultStore {
  constructor(private readonly sql: postgres.Sql) {}

  async get(orgId: string, actorId: string): Promise<PasswordVaultResponse> {
    const [row] = await this.sql<VaultRow[]>`
      select version, ciphertext, previous_ciphertext, previous_updated_at, updated_at
      from password_vaults where org_id = ${orgId} and actor_id = ${actorId}
    `;
    if (!row) return { vault: null, previous: null };
    return {
      vault: {
        version: Number(row.version),
        ciphertext: row.ciphertext.toString("base64"),
        updatedAt: row.updated_at.toISOString(),
      },
      previous:
        row.previous_ciphertext === null || row.previous_updated_at === null
          ? null
          : {
              version: Number(row.version) - 1,
              ciphertext: row.previous_ciphertext.toString("base64"),
              updatedAt: row.previous_updated_at.toISOString(),
            },
    };
  }

  async put(
    orgId: string,
    actorId: string,
    expectedVersion: number,
    ciphertext: Buffer,
  ): Promise<number | null> {
    const [row] =
      expectedVersion === 0
        ? await this.sql<{ version: string }[]>`
          insert into password_vaults (org_id, actor_id, version, ciphertext)
          values (${orgId}, ${actorId}, 1, ${ciphertext})
          on conflict (org_id, actor_id) do nothing returning version
        `
        : await this.sql<{ version: string }[]>`
          update password_vaults set
            previous_ciphertext = ciphertext, previous_updated_at = updated_at,
            ciphertext = ${ciphertext}, version = version + 1, updated_at = now()
          where org_id = ${orgId} and actor_id = ${actorId} and version = ${expectedVersion}
          returning version
        `;
    if (row) return Number(row.version);
    // A lost response can be retried without overwriting a newer revision.
    const [retry] = await this.sql<{ version: string }[]>`
      select version from password_vaults
      where org_id = ${orgId} and actor_id = ${actorId}
        and version = ${expectedVersion + 1} and ciphertext = ${ciphertext}
    `;
    return retry ? Number(retry.version) : null;
  }
}
