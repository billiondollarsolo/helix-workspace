import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import type postgres from "postgres";
import type { TenantEnvelopeCipher } from "../secrets/envelope.js";

export type MailCredentialPurpose = "sending" | "feedback";
export interface MailProviderCredentials {
  read(
    orgId: string,
    providerId: string,
    purpose: MailCredentialPurpose,
  ): Promise<string | undefined>;
  write(
    orgId: string,
    providerId: string,
    purpose: MailCredentialPurpose,
    value: string | null,
  ): Promise<boolean>;
  status(orgId: string, providerId: string): Promise<{ sending: boolean; feedback: boolean }>;
}

/** Existing provider RLS and tenant/provider/purpose-bound envelopes protect every access. */
export class PostgresMailProviderCredentials implements MailProviderCredentials {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly cipher: TenantEnvelopeCipher,
  ) {}

  async read(
    orgId: string,
    providerId: string,
    purpose: MailCredentialPurpose,
  ): Promise<string | undefined> {
    const rows = await withTenantPostgresContext(
      this.sql,
      { orgId },
      async (tx) => tx<{ value: string | null }[]>`
      select case when ${purpose}='sending' then credential_ciphertext else feedback_credential_ciphertext end as value
      from mail_outbound_providers where org_id=${orgId} and id=${providerId}`,
    );
    const value = rows[0]?.value;
    return value == null
      ? undefined
      : this.cipher.open(orgId, `mail-${purpose}.${providerId}`, value);
  }

  async write(
    orgId: string,
    providerId: string,
    purpose: MailCredentialPurpose,
    value: string | null,
  ): Promise<boolean> {
    const sealed =
      value === null ? null : this.cipher.seal(orgId, `mail-${purpose}.${providerId}`, value);
    const rows = await withTenantPostgresContext(
      this.sql,
      { orgId },
      async (tx) => tx<{ id: string }[]>`
      update mail_outbound_providers set
        credential_ciphertext=case when ${purpose}='sending' then ${sealed} else credential_ciphertext end,
        feedback_credential_ciphertext=case when ${purpose}='feedback' then ${sealed} else feedback_credential_ciphertext end,
        secret_ref=case when ${purpose}='sending' then null else secret_ref end,
        webhook_secret_ref=case when ${purpose}='feedback' then null else webhook_secret_ref end,
        updated_at=now()
      where org_id=${orgId} and id=${providerId} returning id`,
    );
    return rows.length === 1;
  }

  async status(
    orgId: string,
    providerId: string,
  ): Promise<{ sending: boolean; feedback: boolean }> {
    const rows = await withTenantPostgresContext(
      this.sql,
      { orgId },
      async (tx) => tx<{ sending: boolean; feedback: boolean }[]>`
      select credential_ciphertext is not null as sending, feedback_credential_ciphertext is not null as feedback
      from mail_outbound_providers where org_id=${orgId} and id=${providerId}`,
    );
    return rows[0] ?? { sending: false, feedback: false };
  }
}
