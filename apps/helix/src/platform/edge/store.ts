import type postgres from "postgres";
import type { TenantEnvelopeCipher } from "../secrets/envelope.js";
import type { EdgeCertificateSummary } from "./certificate.js";

const KEY_PURPOSE = "edge-tls-key";

export interface StoredEdgeCertificate {
  readonly summary: EdgeCertificateSummary;
  readonly updatedAt: string;
}

/** The certificate chain with its private key, for the edge only. */
export interface EdgeCertificateBundle {
  readonly chainPem: string;
  readonly keyPem: string;
  readonly fingerprintSha256: string;
}

interface CertificateRow {
  readonly subject: string;
  readonly issuer: string;
  readonly names: readonly string[];
  readonly not_before: Date;
  readonly not_after: Date;
  readonly fingerprint_sha256: string;
  readonly updated_at: Date;
}

function toStored(row: CertificateRow): StoredEdgeCertificate {
  return {
    summary: {
      subject: row.subject,
      issuer: row.issuer,
      names: [...row.names],
      notBefore: row.not_before.toISOString(),
      notAfter: row.not_after.toISOString(),
      fingerprintSha256: row.fingerprint_sha256,
    },
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * The operator-provided HTTPS certificate of a single-organization
 * deployment. Every method runs on the tenant-aware client, so callers wrap it
 * in the organization's RLS context.
 */
export class PostgresEdgeCertificateStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly cipher: Pick<TenantEnvelopeCipher, "seal" | "open">,
  ) {}

  async get(orgId: string): Promise<StoredEdgeCertificate | null> {
    const rows = await this.sql<CertificateRow[]>`
      select subject, issuer, names, not_before, not_after, fingerprint_sha256, updated_at
      from edge_tls_certificates
      where org_id = ${orgId}
    `;
    return rows[0] === undefined ? null : toStored(rows[0]);
  }

  async readBundle(orgId: string): Promise<EdgeCertificateBundle | null> {
    const rows = await this.sql<
      { chain_pem: string; key_ciphertext: string; fingerprint_sha256: string }[]
    >`
      select chain_pem, key_ciphertext, fingerprint_sha256
      from edge_tls_certificates
      where org_id = ${orgId}
    `;
    const row = rows[0];
    return row === undefined
      ? null
      : {
          chainPem: row.chain_pem,
          keyPem: this.cipher.open(orgId, KEY_PURPOSE, row.key_ciphertext),
          fingerprintSha256: row.fingerprint_sha256,
        };
  }

  async save(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly chainPem: string;
    readonly keyPem: string;
    readonly summary: EdgeCertificateSummary;
  }): Promise<StoredEdgeCertificate> {
    const { summary } = input;
    const rows = await this.sql<CertificateRow[]>`
      insert into edge_tls_certificates (
        org_id, chain_pem, key_ciphertext, subject, issuer, names,
        not_before, not_after, fingerprint_sha256, updated_by_actor_id
      ) values (
        ${input.orgId},
        ${input.chainPem},
        ${this.cipher.seal(input.orgId, KEY_PURPOSE, input.keyPem)},
        ${summary.subject},
        ${summary.issuer},
        ${[...summary.names]},
        ${summary.notBefore},
        ${summary.notAfter},
        ${summary.fingerprintSha256},
        ${input.actorId}
      )
      on conflict (org_id) do update set
        chain_pem = excluded.chain_pem,
        key_ciphertext = excluded.key_ciphertext,
        subject = excluded.subject,
        issuer = excluded.issuer,
        names = excluded.names,
        not_before = excluded.not_before,
        not_after = excluded.not_after,
        fingerprint_sha256 = excluded.fingerprint_sha256,
        updated_by_actor_id = excluded.updated_by_actor_id,
        updated_at = statement_timestamp()
      returning subject, issuer, names, not_before, not_after, fingerprint_sha256, updated_at
    `;
    return toStored(rows[0] as CertificateRow);
  }

  /** Returns the removed certificate, or null when none was stored. */
  async clear(orgId: string): Promise<StoredEdgeCertificate | null> {
    const rows = await this.sql<CertificateRow[]>`
      delete from edge_tls_certificates
      where org_id = ${orgId}
      returning subject, issuer, names, not_before, not_after, fingerprint_sha256, updated_at
    `;
    return rows[0] === undefined ? null : toStored(rows[0]);
  }
}
