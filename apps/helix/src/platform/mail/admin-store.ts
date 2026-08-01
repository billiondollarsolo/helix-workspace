// ponytail: admin-store.ts bundles providers/domains/dkim/dmarc/routing (~1290 LOC).
// Split into admin/*-store.ts when next touching a single domain store (G9).
import { generateKeyPairSync, randomBytes } from "node:crypto";
import type postgres from "postgres";
import { ensureAdminDomain } from "../admin/domain-identity.js";
import type { JsonObject } from "@helix/sdk-types";
import type { OutboundMailProviderKind, OutboundProviderConfig } from "./providers.js";

/**
 * Postgres + in-memory stores for the mail-admin domains:
 *
 *   * Outbound providers   (`mail_outbound_providers`)
 *   * Sending domains      (`mail_sending_domains`)
 *   * DKIM keys            (`mail_dkim_keys`)
 *   * DMARC reports        (`mail_dmarc_reports` / `mail_dmarc_report_records`)
 *   * Inbound routing rules(`mail_inbound_routing_rules`)
 *
 * Every store is org-scoped. The in-memory variants are deterministic so the
 * admin route tests run without a database.
 */

// ===========================================================================
// Records
// ===========================================================================

export type MailDkimKeyStatus = "active" | "retiring" | "retired";
export type MailRoutingActionKind = "forward" | "alias" | "drop" | "tag" | "mailbox";

export interface MailSendingDomainRecord {
  readonly id: string;
  readonly orgId: string;
  readonly domain: string;
  readonly isDefault: boolean;
  readonly verifiedAt: string | null;
  readonly providerId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Status of a DNS record Helix expects for a domain, as tracked in
 *  `admin_dns_records`. Mirrors that table's `status` check constraint. */
export type DnsVerificationState = "verified" | "pending" | "failed";

/** A sending domain plus the DNS posture the console renders beside it.
 *
 *  Kept separate from `MailSendingDomainRecord` because outbound routing reads
 *  that type on the send path and has no use for badge state. */
export interface MailSendingDomainConsoleRecord extends MailSendingDomainRecord {
  readonly spf: DnsVerificationState;
  readonly dkim: DnsVerificationState;
  readonly dmarc: DnsVerificationState;
  readonly dkimKeys: readonly {
    readonly id: string;
    readonly selector: string;
    readonly status: MailDkimKeyStatus;
  }[];
}

/** Why a sending domain is or is not verified, so the console can say which
 *  record is missing instead of just refusing. */
export interface DomainVerificationResult {
  readonly domain: MailSendingDomainRecord;
  readonly spf: DnsVerificationState;
  readonly dkim: DnsVerificationState;
  /** True when SPF and DKIM both verify — what signing as this domain needs. */
  readonly verified: boolean;
}

export interface MailDkimKeyRecord {
  readonly id: string;
  readonly orgId: string;
  readonly domainId: string;
  readonly selector: string;
  readonly status: MailDkimKeyStatus;
  readonly algorithm: string;
  readonly keyBits: number;
  /** PEM private key — never serialized to clients; admin routes redact it. */
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly dnsRecord: string;
  readonly rotatedAt: string | null;
  readonly retiredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MailDmarcReportRecord {
  readonly id: string;
  readonly orgId: string;
  readonly domain: string;
  readonly orgName: string;
  readonly reportId: string;
  readonly dateRangeBegin: string;
  readonly dateRangeEnd: string;
  readonly policyP: string;
  readonly policySp: string | null;
  readonly policyPct: number | null;
  readonly totalMessages: number;
  readonly passMessages: number;
  readonly failMessages: number;
  readonly createdAt: string;
}

export interface MailDmarcReportRowRecord {
  readonly sourceIp: string;
  readonly messageCount: number;
  readonly disposition: string;
  readonly dkimResult: string;
  readonly spfResult: string;
  readonly headerFrom: string;
}

export interface MailDmarcSummary {
  readonly domain: string;
  readonly totalMessages: number;
  readonly passMessages: number;
  readonly failMessages: number;
  readonly passRate: number;
  readonly reportCount: number;
  readonly topFailingSources: readonly {
    readonly sourceIp: string;
    readonly messageCount: number;
  }[];
}

export interface MailRoutingRuleRecord {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly isEnabled: boolean;
  readonly priority: number;
  readonly match: JsonObject;
  readonly actionKind: MailRoutingActionKind;
  readonly action: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ===========================================================================
// Errors
// ===========================================================================

/** Raised when a uniqueness rule (name / domain / selector) is violated. */
export class MailAdminConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailAdminConflictError";
  }
}

// ===========================================================================
// Store interfaces
// ===========================================================================

export interface CreateOutboundProviderInput {
  readonly orgId: string;
  readonly name: string;
  readonly kind: OutboundMailProviderKind;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly config: JsonObject;
  readonly secretRef: string | null;
  readonly webhookSecretRef?: string | null;
  readonly createdBy: string;
}

export interface UpdateOutboundProviderInput {
  readonly orgId: string;
  readonly id: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly isDefault?: boolean;
  readonly config?: JsonObject;
  readonly secretRef?: string | null;
  readonly webhookSecretRef?: string | null;
}

export interface OutboundProviderStore {
  listProviders(orgId: string): Promise<readonly OutboundProviderConfig[]>;
  getProvider(orgId: string, id: string): Promise<OutboundProviderConfig | null>;
  getDefaultProvider(orgId: string): Promise<OutboundProviderConfig | null>;
  createProvider(input: CreateOutboundProviderInput): Promise<OutboundProviderConfig>;
  updateProvider(input: UpdateOutboundProviderInput): Promise<OutboundProviderConfig | null>;
  deleteProvider(orgId: string, id: string): Promise<boolean>;
}

export interface CreateSendingDomainInput {
  readonly orgId: string;
  readonly domain: string;
  readonly isDefault: boolean;
  readonly providerId: string | null;
  readonly createdBy: string;
}

export interface SendingDomainStore {
  listDomains(orgId: string): Promise<readonly MailSendingDomainRecord[]>;
  /* The console's view: the same domains, joined to the DNS posture recorded
     against their `admin_domains` parent. Separate from `listDomains` so the
     send path does not pay for a three-table join it never reads. */
  listDomainsForConsole(orgId: string): Promise<readonly MailSendingDomainConsoleRecord[]>;
  getDomain(orgId: string, id: string): Promise<MailSendingDomainRecord | null>;
  createDomain(input: CreateSendingDomainInput): Promise<MailSendingDomainRecord>;
  /* Recompute whether this domain may sign as itself, from the DNS records
     actually observed against its `admin_domains` parent.
 
     Replaces `setDomainVerified(orgId, id, verified)`, which wrote
     `verified_at = now()` because the CALLER said so -- no lookup of any kind.
     Outbound routing gates dedicated-provider selection on that column, so a
     client could talk its way into a transport by asserting a boolean. */
  refreshDomainVerification(orgId: string, id: string): Promise<DomainVerificationResult | null>;
  deleteDomain(orgId: string, id: string): Promise<boolean>;
}

export interface MailDkimKeyStore {
  listKeys(orgId: string, domainId: string): Promise<readonly MailDkimKeyRecord[]>;
  /** Generate a fresh key, promoting it to `active` and demoting any previous active key. */
  generateKey(input: {
    readonly orgId: string;
    readonly domainId: string;
    readonly selector: string;
    readonly domain: string;
    readonly keyBits?: number;
    readonly createdBy: string;
  }): Promise<MailDkimKeyRecord>;
  /** Rotate: mark the named retiring key fully `retired`. */
  retireKey(orgId: string, id: string): Promise<MailDkimKeyRecord | null>;
}

export interface IngestDmarcReportInput {
  readonly orgId: string;
  readonly domain: string;
  readonly orgName: string;
  readonly reportId: string;
  readonly dateRangeBegin: Date;
  readonly dateRangeEnd: Date;
  readonly policyP: string;
  readonly policySp: string | null;
  readonly policyPct: number | null;
  readonly records: readonly MailDmarcReportRowRecord[];
  readonly raw: JsonObject;
}

export interface MailDmarcReportStore {
  ingestReport(input: IngestDmarcReportInput): Promise<MailDmarcReportRecord>;
  listReports(orgId: string, domain?: string): Promise<readonly MailDmarcReportRecord[]>;
  getSummary(orgId: string, domain: string): Promise<MailDmarcSummary>;
}

export interface CreateRoutingRuleInput {
  readonly orgId: string;
  readonly name: string;
  readonly isEnabled: boolean;
  readonly priority: number;
  readonly match: JsonObject;
  readonly actionKind: MailRoutingActionKind;
  readonly action: JsonObject;
  readonly createdBy: string;
}

export interface UpdateRoutingRuleInput {
  readonly orgId: string;
  readonly id: string;
  readonly name?: string;
  readonly isEnabled?: boolean;
  readonly priority?: number;
  readonly match?: JsonObject;
  readonly actionKind?: MailRoutingActionKind;
  readonly action?: JsonObject;
}

export interface MailRoutingRuleStore {
  listRules(orgId: string): Promise<readonly MailRoutingRuleRecord[]>;
  getRule(orgId: string, id: string): Promise<MailRoutingRuleRecord | null>;
  createRule(input: CreateRoutingRuleInput): Promise<MailRoutingRuleRecord>;
  updateRule(input: UpdateRoutingRuleInput): Promise<MailRoutingRuleRecord | null>;
  deleteRule(orgId: string, id: string): Promise<boolean>;
}

// ===========================================================================
// DKIM key generation
// ===========================================================================

/**
 * Generate an RSA DKIM key pair and the DNS TXT record value to publish at
 * `<selector>._domainkey.<domain>`. The DNS record carries the base64 DER of
 * the SubjectPublicKeyInfo, matching how `mailauth` and verifiers expect it.
 */
export function generateDkimKeyMaterial(keyBits: number): {
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly dnsPublicKey: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: keyBits,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const publicKeyPem = publicKey;
  const dnsPublicKey = publicKeyPem
    .replace(/-----BEGIN PUBLIC KEY-----/u, "")
    .replace(/-----END PUBLIC KEY-----/u, "")
    .replace(/\s+/gu, "");
  return { privateKeyPem: privateKey, publicKeyPem, dnsPublicKey };
}

/** Compose the DKIM DNS TXT record value. */
export function dkimDnsRecord(dnsPublicKey: string): string {
  return `v=DKIM1; k=rsa; p=${dnsPublicKey}`;
}

// ===========================================================================
// Postgres stores
// ===========================================================================

function toSqlJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

interface OutboundProviderRow {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly kind: OutboundMailProviderKind;
  readonly enabled: boolean;
  readonly is_default: boolean;
  readonly config: JsonObject;
  readonly secret_ref: string | null;
  readonly webhook_secret_ref?: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function mapProviderRow(row: OutboundProviderRow): OutboundProviderConfig {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    kind: row.kind,
    enabled: row.enabled,
    isDefault: row.is_default,
    config: row.config,
    secretRef: row.secret_ref,
    webhookSecretRef: row.webhook_secret_ref ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresOutboundProviderStore implements OutboundProviderStore {
  constructor(private readonly sql: postgres.Sql) {}

  async listProviders(orgId: string): Promise<readonly OutboundProviderConfig[]> {
    const rows = (await this.sql`
      select * from mail_outbound_providers
      where org_id = ${orgId}
      order by is_default desc, created_at asc, id asc
    `) as unknown as readonly OutboundProviderRow[];
    return rows.map(mapProviderRow);
  }

  async getProvider(orgId: string, id: string): Promise<OutboundProviderConfig | null> {
    const rows = (await this.sql`
      select * from mail_outbound_providers where org_id = ${orgId} and id = ${id}
    `) as unknown as readonly OutboundProviderRow[];
    return rows[0] === undefined ? null : mapProviderRow(rows[0]);
  }

  async getDefaultProvider(orgId: string): Promise<OutboundProviderConfig | null> {
    const rows = (await this.sql`
      select * from mail_outbound_providers
      where org_id = ${orgId} and is_default = true and enabled = true
      limit 1
    `) as unknown as readonly OutboundProviderRow[];
    return rows[0] === undefined ? null : mapProviderRow(rows[0]);
  }

  async createProvider(input: CreateOutboundProviderInput): Promise<OutboundProviderConfig> {
    return this.sql.begin(async (tx) => {
      if (input.isDefault) {
        await tx`
          update mail_outbound_providers set is_default = false, updated_at = now()
          where org_id = ${input.orgId}
        `;
      }
      const rows = (await tx`
        insert into mail_outbound_providers
          (
            org_id, name, kind, enabled, is_default, config, secret_ref,
            webhook_secret_ref, created_by
          )
        values (
          ${input.orgId}, ${input.name}, ${input.kind}, ${input.enabled},
          ${input.isDefault}, ${tx.json(toSqlJson(input.config))}, ${input.secretRef},
          ${input.webhookSecretRef ?? null}, ${input.createdBy}
        )
        on conflict do nothing
        returning *
      `) as unknown as readonly OutboundProviderRow[];
      if (rows[0] === undefined) {
        throw new MailAdminConflictError(
          `An outbound provider named "${input.name}" already exists.`,
        );
      }
      return mapProviderRow(rows[0]);
    });
  }

  async updateProvider(input: UpdateOutboundProviderInput): Promise<OutboundProviderConfig | null> {
    return this.sql.begin(async (tx) => {
      const existing = (await tx`
        select * from mail_outbound_providers where org_id = ${input.orgId} and id = ${input.id}
      `) as unknown as readonly OutboundProviderRow[];
      const current = existing[0];
      if (current === undefined) {
        return null;
      }
      if (input.isDefault === true) {
        await tx`
          update mail_outbound_providers set is_default = false, updated_at = now()
          where org_id = ${input.orgId} and id <> ${input.id}
        `;
      }
      const rows = (await tx`
        update mail_outbound_providers
        set
          name = ${input.name ?? current.name},
          enabled = ${input.enabled ?? current.enabled},
          is_default = ${input.isDefault ?? current.is_default},
          config = ${tx.json(toSqlJson(input.config ?? current.config))},
          secret_ref = ${input.secretRef === undefined ? current.secret_ref : input.secretRef},
          webhook_secret_ref = ${
            input.webhookSecretRef === undefined
              ? (current.webhook_secret_ref ?? null)
              : input.webhookSecretRef
          },
          updated_at = now()
        where org_id = ${input.orgId} and id = ${input.id}
        returning *
      `) as unknown as readonly OutboundProviderRow[];
      return rows[0] === undefined ? null : mapProviderRow(rows[0]);
    });
  }

  async deleteProvider(orgId: string, id: string): Promise<boolean> {
    const rows = (await this.sql`
      delete from mail_outbound_providers where org_id = ${orgId} and id = ${id} returning id
    `) as unknown as readonly { readonly id: string }[];
    return rows.length > 0;
  }
}

interface SendingDomainRow {
  readonly id: string;
  readonly org_id: string;
  readonly domain: string;
  readonly is_default: boolean;
  readonly verified_at: Date | null;
  readonly provider_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function mapDomainRow(row: SendingDomainRow): MailSendingDomainRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    domain: row.domain,
    isDefault: row.is_default,
    verifiedAt: row.verified_at?.toISOString() ?? null,
    providerId: row.provider_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresSendingDomainStore implements SendingDomainStore {
  constructor(private readonly sql: postgres.Sql) {}

  async listDomains(orgId: string): Promise<readonly MailSendingDomainRecord[]> {
    const rows = (await this.sql`
      select * from mail_sending_domains
      where org_id = ${orgId}
      order by is_default desc, domain asc
    `) as unknown as readonly SendingDomainRow[];
    return rows.map(mapDomainRow);
  }

  /* SPF/DKIM/DMARC live in `admin_dns_records`, keyed to the domain identity
     this sending domain hangs off. Before migration 0086 there was no link, so
     the console asked for three fields the server had no way to produce and the
     view failed to parse the moment one domain existed.

     A record type with no row reads `pending`: nothing has verified, which is
     true. It does not distinguish "not published yet" from "Helix never said
     what to publish" — that belongs on the DNS panel, which lists the expected
     records themselves. */
  async listDomainsForConsole(orgId: string): Promise<readonly MailSendingDomainConsoleRecord[]> {
    const rows = (await this.sql`
      select
        d.*,
        coalesce(
          (select r.status from admin_dns_records r
           where r.domain_id = d.admin_domain_id and r.record_type = 'SPF' limit 1),
          'pending'
        ) as spf_status,
        coalesce(
          (select r.status from admin_dns_records r
           where r.domain_id = d.admin_domain_id and r.record_type = 'DKIM' limit 1),
          'pending'
        ) as dkim_status,
        coalesce(
          (select r.status from admin_dns_records r
           where r.domain_id = d.admin_domain_id and r.record_type = 'DMARC' limit 1),
          'pending'
        ) as dmarc_status,
        coalesce(
          (select json_agg(json_build_object('id', k.id, 'selector', k.selector,
                                             'status', k.status)
                           order by k.created_at)
           from mail_dkim_keys k where k.domain_id = d.id),
          '[]'::json
        ) as dkim_keys
      from mail_sending_domains d
      where d.org_id = ${orgId}
      order by d.is_default desc, d.domain asc
    `) as unknown as readonly (SendingDomainRow & {
      readonly spf_status: DnsVerificationState;
      readonly dkim_status: DnsVerificationState;
      readonly dmarc_status: DnsVerificationState;
      readonly dkim_keys: readonly {
        readonly id: string;
        readonly selector: string;
        readonly status: MailDkimKeyStatus;
      }[];
    })[];
    return rows.map((row) => ({
      ...mapDomainRow(row),
      spf: row.spf_status,
      dkim: row.dkim_status,
      dmarc: row.dmarc_status,
      dkimKeys: row.dkim_keys,
    }));
  }

  async getDomain(orgId: string, id: string): Promise<MailSendingDomainRecord | null> {
    const rows = (await this.sql`
      select * from mail_sending_domains where org_id = ${orgId} and id = ${id}
    `) as unknown as readonly SendingDomainRow[];
    return rows[0] === undefined ? null : mapDomainRow(rows[0]);
  }

  async createDomain(input: CreateSendingDomainInput): Promise<MailSendingDomainRecord> {
    return this.sql.begin(async (tx) => {
      if (input.isDefault) {
        await tx`
          update mail_sending_domains set is_default = false, updated_at = now()
          where org_id = ${input.orgId}
        `;
      }
      /* Inside the transaction: a capability must never outlive a rollback
         that removed the identity it points at. */
      const adminDomainId = await ensureAdminDomain(tx as unknown as postgres.Sql, {
        orgId: input.orgId,
        domain: input.domain,
        createdBy: input.createdBy,
      });
      const rows = (await tx`
        insert into mail_sending_domains
          (org_id, admin_domain_id, domain, is_default, provider_id, created_by)
        values (
          ${input.orgId}, ${adminDomainId}, ${input.domain}, ${input.isDefault},
          ${input.providerId}, ${input.createdBy}
        )
        on conflict do nothing
        returning *
      `) as unknown as readonly SendingDomainRow[];
      if (rows[0] === undefined) {
        throw new MailAdminConflictError(
          `The sending domain "${input.domain}" is already registered.`,
        );
      }
      return mapDomainRow(rows[0]);
    });
  }

  /* SPF authorises the envelope, DKIM signs the message. Mail leaving a domain
     with only one of them in place fails at a meaningful share of receivers,
     so both must verify before Helix treats the domain as its own. */
  async refreshDomainVerification(
    orgId: string,
    id: string,
  ): Promise<DomainVerificationResult | null> {
    const rows = (await this.sql`
      with posture as (
        select
          d.id,
          coalesce(
            (select r.status from admin_dns_records r
             where r.domain_id = d.admin_domain_id and r.record_type = 'SPF' limit 1),
            'pending'
          ) as spf,
          coalesce(
            (select r.status from admin_dns_records r
             where r.domain_id = d.admin_domain_id and r.record_type = 'DKIM' limit 1),
            'pending'
          ) as dkim
        from mail_sending_domains d
        where d.org_id = ${orgId} and d.id = ${id}
      )
      update mail_sending_domains d
      set verified_at = case
            when posture.spf = 'verified' and posture.dkim = 'verified'
              then coalesce(d.verified_at, now())
            else null
          end,
          updated_at = now()
      from posture
      where d.id = posture.id
      returning d.*, posture.spf, posture.dkim
    `) as unknown as readonly (SendingDomainRow & {
      readonly spf: DnsVerificationState;
      readonly dkim: DnsVerificationState;
    })[];
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      domain: mapDomainRow(row),
      spf: row.spf,
      dkim: row.dkim,
      verified: row.verified_at !== null,
    };
  }

  async deleteDomain(orgId: string, id: string): Promise<boolean> {
    const rows = (await this.sql`
      delete from mail_sending_domains where org_id = ${orgId} and id = ${id} returning id
    `) as unknown as readonly { readonly id: string }[];
    return rows.length > 0;
  }
}

interface DkimKeyRow {
  readonly id: string;
  readonly org_id: string;
  readonly domain_id: string;
  readonly selector: string;
  readonly status: MailDkimKeyStatus;
  readonly algorithm: string;
  readonly key_bits: number;
  readonly private_key_pem: string;
  readonly public_key_pem: string;
  readonly dns_record: string;
  readonly rotated_at: Date | null;
  readonly retired_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function mapDkimRow(row: DkimKeyRow): MailDkimKeyRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    domainId: row.domain_id,
    selector: row.selector,
    status: row.status,
    algorithm: row.algorithm,
    keyBits: row.key_bits,
    privateKeyPem: row.private_key_pem,
    publicKeyPem: row.public_key_pem,
    dnsRecord: row.dns_record,
    rotatedAt: row.rotated_at?.toISOString() ?? null,
    retiredAt: row.retired_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresMailDkimKeyStore implements MailDkimKeyStore {
  constructor(private readonly sql: postgres.Sql) {}

  async listKeys(orgId: string, domainId: string): Promise<readonly MailDkimKeyRecord[]> {
    const rows = (await this.sql`
      select * from mail_dkim_keys
      where org_id = ${orgId} and domain_id = ${domainId}
      order by created_at desc, id desc
    `) as unknown as readonly DkimKeyRow[];
    return rows.map(mapDkimRow);
  }

  async generateKey(input: {
    readonly orgId: string;
    readonly domainId: string;
    readonly selector: string;
    readonly domain: string;
    readonly keyBits?: number;
    readonly createdBy: string;
  }): Promise<MailDkimKeyRecord> {
    const keyBits = input.keyBits ?? 2048;
    const material = generateDkimKeyMaterial(keyBits);
    return this.sql.begin(async (tx) => {
      // Demote any current active key to `retiring` — it stays published in DNS
      // until in-flight mail signed with it has drained, then is retired.
      await tx`
        update mail_dkim_keys
        set status = 'retiring', rotated_at = now(), updated_at = now()
        where org_id = ${input.orgId} and domain_id = ${input.domainId} and status = 'active'
      `;
      const rows = (await tx`
        insert into mail_dkim_keys (
          org_id, domain_id, selector, status, algorithm, key_bits,
          private_key_pem, public_key_pem, dns_record, created_by
        )
        values (
          ${input.orgId}, ${input.domainId}, ${input.selector}, 'active', 'rsa-sha256',
          ${keyBits}, ${material.privateKeyPem}, ${material.publicKeyPem},
          ${dkimDnsRecord(material.dnsPublicKey)}, ${input.createdBy}
        )
        on conflict do nothing
        returning *
      `) as unknown as readonly DkimKeyRow[];
      if (rows[0] === undefined) {
        throw new MailAdminConflictError(
          `A DKIM key with selector "${input.selector}" already exists for this domain.`,
        );
      }
      return mapDkimRow(rows[0]);
    });
  }

  async retireKey(orgId: string, id: string): Promise<MailDkimKeyRecord | null> {
    const rows = (await this.sql`
      update mail_dkim_keys
      set status = 'retired', retired_at = now(), updated_at = now()
      where org_id = ${orgId} and id = ${id} and status <> 'retired'
      returning *
    `) as unknown as readonly DkimKeyRow[];
    return rows[0] === undefined ? null : mapDkimRow(rows[0]);
  }
}

interface DmarcReportRow {
  readonly id: string;
  readonly org_id: string;
  readonly domain: string;
  readonly org_name: string;
  readonly report_id: string;
  readonly date_range_begin: Date;
  readonly date_range_end: Date;
  readonly policy_p: string;
  readonly policy_sp: string | null;
  readonly policy_pct: number | null;
  readonly total_messages: number;
  readonly pass_messages: number;
  readonly fail_messages: number;
  readonly created_at: Date;
}

function mapDmarcRow(row: DmarcReportRow): MailDmarcReportRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    domain: row.domain,
    orgName: row.org_name,
    reportId: row.report_id,
    dateRangeBegin: row.date_range_begin.toISOString(),
    dateRangeEnd: row.date_range_end.toISOString(),
    policyP: row.policy_p,
    policySp: row.policy_sp,
    policyPct: row.policy_pct,
    totalMessages: row.total_messages,
    passMessages: row.pass_messages,
    failMessages: row.fail_messages,
    createdAt: row.created_at.toISOString(),
  };
}

export class PostgresMailDmarcReportStore implements MailDmarcReportStore {
  constructor(private readonly sql: postgres.Sql) {}

  async ingestReport(input: IngestDmarcReportInput): Promise<MailDmarcReportRecord> {
    const totals = aggregateDmarcRecords(input.records);
    return this.sql.begin(async (tx) => {
      const rows = (await tx`
        insert into mail_dmarc_reports (
          org_id, domain, org_name, report_id, date_range_begin, date_range_end,
          policy_p, policy_sp, policy_pct, total_messages, pass_messages, fail_messages, raw
        )
        values (
          ${input.orgId}, ${input.domain.toLowerCase()}, ${input.orgName}, ${input.reportId},
          ${input.dateRangeBegin}, ${input.dateRangeEnd}, ${input.policyP}, ${input.policySp},
          ${input.policyPct}, ${totals.total}, ${totals.pass}, ${totals.fail},
          ${tx.json(toSqlJson(input.raw))}
        )
        on conflict (org_id, lower(domain), org_name, report_id) do update
        set
          date_range_begin = excluded.date_range_begin,
          date_range_end = excluded.date_range_end,
          policy_p = excluded.policy_p,
          policy_sp = excluded.policy_sp,
          policy_pct = excluded.policy_pct,
          total_messages = excluded.total_messages,
          pass_messages = excluded.pass_messages,
          fail_messages = excluded.fail_messages,
          raw = excluded.raw
        returning *
      `) as unknown as readonly DmarcReportRow[];
      const report = rows[0];
      if (report === undefined) {
        throw new Error("Failed to ingest DMARC report.");
      }
      await tx`
        delete from mail_dmarc_report_records where report_id = ${report.id}
      `;
      for (const record of input.records) {
        await tx`
          insert into mail_dmarc_report_records (
            report_id, org_id, source_ip, message_count, disposition,
            dkim_result, spf_result, header_from
          )
          values (
            ${report.id}, ${input.orgId}, ${record.sourceIp}, ${record.messageCount},
            ${record.disposition}, ${record.dkimResult}, ${record.spfResult},
            ${record.headerFrom}
          )
        `;
      }
      return mapDmarcRow(report);
    });
  }

  async listReports(orgId: string, domain?: string): Promise<readonly MailDmarcReportRecord[]> {
    const rows = (await this.sql`
      select * from mail_dmarc_reports
      where org_id = ${orgId}
        and (${domain ?? null}::text is null or lower(domain) = ${(domain ?? "").toLowerCase()})
      order by date_range_end desc, id desc
      limit 200
    `) as unknown as readonly DmarcReportRow[];
    return rows.map(mapDmarcRow);
  }

  async getSummary(orgId: string, domain: string): Promise<MailDmarcSummary> {
    const totalsRows = (await this.sql`
      select
        coalesce(sum(total_messages), 0)::int as total,
        coalesce(sum(pass_messages), 0)::int as pass,
        coalesce(sum(fail_messages), 0)::int as fail,
        count(*)::int as report_count
      from mail_dmarc_reports
      where org_id = ${orgId} and lower(domain) = ${domain.toLowerCase()}
    `) as unknown as readonly {
      readonly total: number;
      readonly pass: number;
      readonly fail: number;
      readonly report_count: number;
    }[];
    const sources = (await this.sql`
      select rr.source_ip, sum(rr.message_count)::int as message_count
      from mail_dmarc_report_records rr
      join mail_dmarc_reports r on r.id = rr.report_id
      where rr.org_id = ${orgId}
        and lower(r.domain) = ${domain.toLowerCase()}
        and (rr.dkim_result <> 'pass' or rr.spf_result <> 'pass')
      group by rr.source_ip
      order by message_count desc
      limit 10
    `) as unknown as readonly {
      readonly source_ip: string;
      readonly message_count: number;
    }[];
    const totals = totalsRows[0] ?? { total: 0, pass: 0, fail: 0, report_count: 0 };
    return {
      domain: domain.toLowerCase(),
      totalMessages: totals.total,
      passMessages: totals.pass,
      failMessages: totals.fail,
      passRate: totals.total === 0 ? 1 : totals.pass / totals.total,
      reportCount: totals.report_count,
      topFailingSources: sources.map((row) => ({
        sourceIp: row.source_ip,
        messageCount: row.message_count,
      })),
    };
  }
}

interface RoutingRuleRow {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly is_enabled: boolean;
  readonly priority: number;
  readonly match: JsonObject;
  readonly action_kind: MailRoutingActionKind;
  readonly action: JsonObject;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function mapRoutingRow(row: RoutingRuleRow): MailRoutingRuleRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    isEnabled: row.is_enabled,
    priority: row.priority,
    match: row.match,
    actionKind: row.action_kind,
    action: row.action,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresMailRoutingRuleStore implements MailRoutingRuleStore {
  constructor(private readonly sql: postgres.Sql) {}

  async listRules(orgId: string): Promise<readonly MailRoutingRuleRecord[]> {
    const rows = (await this.sql`
      select * from mail_inbound_routing_rules
      where org_id = ${orgId}
      order by priority asc, created_at asc
    `) as unknown as readonly RoutingRuleRow[];
    return rows.map(mapRoutingRow);
  }

  async getRule(orgId: string, id: string): Promise<MailRoutingRuleRecord | null> {
    const rows = (await this.sql`
      select * from mail_inbound_routing_rules where org_id = ${orgId} and id = ${id}
    `) as unknown as readonly RoutingRuleRow[];
    return rows[0] === undefined ? null : mapRoutingRow(rows[0]);
  }

  async createRule(input: CreateRoutingRuleInput): Promise<MailRoutingRuleRecord> {
    const rows = (await this.sql`
      insert into mail_inbound_routing_rules (
        org_id, name, is_enabled, priority, match, action_kind, action, created_by
      )
      values (
        ${input.orgId}, ${input.name}, ${input.isEnabled}, ${input.priority},
        ${this.sql.json(toSqlJson(input.match))}, ${input.actionKind},
        ${this.sql.json(toSqlJson(input.action))}, ${input.createdBy}
      )
      on conflict do nothing
      returning *
    `) as unknown as readonly RoutingRuleRow[];
    if (rows[0] === undefined) {
      throw new MailAdminConflictError(`A routing rule named "${input.name}" already exists.`);
    }
    return mapRoutingRow(rows[0]);
  }

  async updateRule(input: UpdateRoutingRuleInput): Promise<MailRoutingRuleRecord | null> {
    const current = await this.getRule(input.orgId, input.id);
    if (current === null) {
      return null;
    }
    const rows = (await this.sql`
      update mail_inbound_routing_rules
      set
        name = ${input.name ?? current.name},
        is_enabled = ${input.isEnabled ?? current.isEnabled},
        priority = ${input.priority ?? current.priority},
        match = ${this.sql.json(toSqlJson(input.match ?? current.match))},
        action_kind = ${input.actionKind ?? current.actionKind},
        action = ${this.sql.json(toSqlJson(input.action ?? current.action))},
        updated_at = now()
      where org_id = ${input.orgId} and id = ${input.id}
      returning *
    `) as unknown as readonly RoutingRuleRow[];
    return rows[0] === undefined ? null : mapRoutingRow(rows[0]);
  }

  async deleteRule(orgId: string, id: string): Promise<boolean> {
    const rows = (await this.sql`
      delete from mail_inbound_routing_rules where org_id = ${orgId} and id = ${id} returning id
    `) as unknown as readonly { readonly id: string }[];
    return rows.length > 0;
  }
}

function aggregateDmarcRecords(records: readonly MailDmarcReportRowRecord[]): {
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
} {
  let total = 0;
  let pass = 0;
  for (const record of records) {
    total += record.messageCount;
    // DMARC passes when SPF or DKIM aligns and passes.
    if (record.dkimResult === "pass" || record.spfResult === "pass") {
      pass += record.messageCount;
    }
  }
  return { total, pass, fail: total - pass };
}

// ===========================================================================
// In-memory stores (tests / offline)
// ===========================================================================

function isoNow(now: () => Date): string {
  return now().toISOString();
}

function genId(seq: number): string {
  return `00000000-0000-4000-c000-${seq.toString(16).padStart(12, "0")}`;
}

export class InMemoryOutboundProviderStore implements OutboundProviderStore {
  readonly #providers = new Map<string, OutboundProviderConfig>();
  #seq = 0;

  constructor(private readonly now: () => Date = () => new Date("2026-05-21T00:00:00.000Z")) {}

  async listProviders(orgId: string): Promise<readonly OutboundProviderConfig[]> {
    return [...this.#providers.values()]
      .filter((provider) => provider.orgId === orgId)
      .sort((a, b) =>
        a.isDefault === b.isDefault ? a.createdAt.localeCompare(b.createdAt) : a.isDefault ? -1 : 1,
      );
  }

  async getProvider(orgId: string, id: string): Promise<OutboundProviderConfig | null> {
    const provider = this.#providers.get(id);
    return provider === undefined || provider.orgId !== orgId ? null : provider;
  }

  async getDefaultProvider(orgId: string): Promise<OutboundProviderConfig | null> {
    return (
      [...this.#providers.values()].find(
        (provider) => provider.orgId === orgId && provider.isDefault && provider.enabled,
      ) ?? null
    );
  }

  async createProvider(input: CreateOutboundProviderInput): Promise<OutboundProviderConfig> {
    const clash = [...this.#providers.values()].some(
      (provider) =>
        provider.orgId === input.orgId && provider.name.toLowerCase() === input.name.toLowerCase(),
    );
    if (clash) {
      throw new MailAdminConflictError(
        `An outbound provider named "${input.name}" already exists.`,
      );
    }
    if (input.isDefault) {
      for (const provider of this.#providers.values()) {
        if (provider.orgId === input.orgId && provider.isDefault) {
          this.#providers.set(provider.id, { ...provider, isDefault: false });
        }
      }
    }
    this.#seq += 1;
    const timestamp = isoNow(this.now);
    const provider: OutboundProviderConfig = {
      id: genId(this.#seq),
      orgId: input.orgId,
      name: input.name,
      kind: input.kind,
      enabled: input.enabled,
      isDefault: input.isDefault,
      config: input.config,
      secretRef: input.secretRef,
      webhookSecretRef: input.webhookSecretRef ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#providers.set(provider.id, provider);
    return provider;
  }

  async updateProvider(input: UpdateOutboundProviderInput): Promise<OutboundProviderConfig | null> {
    const current = this.#providers.get(input.id);
    if (current === undefined || current.orgId !== input.orgId) {
      return null;
    }
    if (input.isDefault === true) {
      for (const provider of this.#providers.values()) {
        if (provider.orgId === input.orgId && provider.id !== input.id && provider.isDefault) {
          this.#providers.set(provider.id, { ...provider, isDefault: false });
        }
      }
    }
    const updated: OutboundProviderConfig = {
      ...current,
      name: input.name ?? current.name,
      enabled: input.enabled ?? current.enabled,
      isDefault: input.isDefault ?? current.isDefault,
      config: input.config ?? current.config,
      secretRef: input.secretRef === undefined ? current.secretRef : input.secretRef,
      webhookSecretRef:
        input.webhookSecretRef === undefined
          ? (current.webhookSecretRef ?? null)
          : input.webhookSecretRef,
      updatedAt: isoNow(this.now),
    };
    this.#providers.set(updated.id, updated);
    return updated;
  }

  async deleteProvider(orgId: string, id: string): Promise<boolean> {
    const provider = this.#providers.get(id);
    if (provider === undefined || provider.orgId !== orgId) {
      return false;
    }
    this.#providers.delete(id);
    return true;
  }
}

export class InMemorySendingDomainStore implements SendingDomainStore {
  readonly #domains = new Map<string, MailSendingDomainRecord>();
  readonly #posture = new Map<string, { spf: DnsVerificationState; dkim: DnsVerificationState }>();
  #seq = 0;

  constructor(private readonly now: () => Date = () => new Date("2026-05-21T00:00:00.000Z")) {}

  async listDomains(orgId: string): Promise<readonly MailSendingDomainRecord[]> {
    return [...this.#domains.values()]
      .filter((domain) => domain.orgId === orgId)
      .sort((a, b) =>
        a.isDefault === b.isDefault ? a.domain.localeCompare(b.domain) : a.isDefault ? -1 : 1,
      );
  }

  /* No admin_dns_records or DKIM keys in memory: this adapter backs route
     tests, which assert the shape reaches the client, not DNS state. */
  async listDomainsForConsole(orgId: string): Promise<readonly MailSendingDomainConsoleRecord[]> {
    const domains = await this.listDomains(orgId);
    return domains.map((domain) => ({
      ...domain,
      spf: "pending" as const,
      dkim: "pending" as const,
      dmarc: "pending" as const,
      dkimKeys: [],
    }));
  }

  async getDomain(orgId: string, id: string): Promise<MailSendingDomainRecord | null> {
    const domain = this.#domains.get(id);
    return domain === undefined || domain.orgId !== orgId ? null : domain;
  }

  async createDomain(input: CreateSendingDomainInput): Promise<MailSendingDomainRecord> {
    const clash = [...this.#domains.values()].some(
      (domain) =>
        domain.orgId === input.orgId && domain.domain.toLowerCase() === input.domain.toLowerCase(),
    );
    if (clash) {
      throw new MailAdminConflictError(
        `The sending domain "${input.domain}" is already registered.`,
      );
    }
    if (input.isDefault) {
      for (const domain of this.#domains.values()) {
        if (domain.orgId === input.orgId && domain.isDefault) {
          this.#domains.set(domain.id, { ...domain, isDefault: false });
        }
      }
    }
    this.#seq += 1;
    const timestamp = isoNow(this.now);
    const domain: MailSendingDomainRecord = {
      id: genId(this.#seq),
      orgId: input.orgId,
      domain: input.domain,
      isDefault: input.isDefault,
      verifiedAt: null,
      providerId: input.providerId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#domains.set(domain.id, domain);
    return domain;
  }

  /* Test seam: this adapter has no admin_dns_records, so a test states the
     posture directly. It is NOT on `SendingDomainStore` — nothing in the
     product may assert its own DNS state. */
  setDnsPosture(id: string, posture: { spf: DnsVerificationState; dkim: DnsVerificationState }) {
    this.#posture.set(id, posture);
  }

  async refreshDomainVerification(
    orgId: string,
    id: string,
  ): Promise<DomainVerificationResult | null> {
    const domain = this.#domains.get(id);
    if (domain === undefined || domain.orgId !== orgId) {
      return null;
    }
    const posture = this.#posture.get(id) ?? { spf: "pending" as const, dkim: "pending" as const };
    const verified = posture.spf === "verified" && posture.dkim === "verified";
    const updated: MailSendingDomainRecord = {
      ...domain,
      verifiedAt: verified ? (domain.verifiedAt ?? isoNow(this.now)) : null,
      updatedAt: isoNow(this.now),
    };
    this.#domains.set(updated.id, updated);
    return { domain: updated, spf: posture.spf, dkim: posture.dkim, verified };
  }

  async deleteDomain(orgId: string, id: string): Promise<boolean> {
    const domain = this.#domains.get(id);
    if (domain === undefined || domain.orgId !== orgId) {
      return false;
    }
    this.#domains.delete(id);
    return true;
  }
}

export class InMemoryMailDkimKeyStore implements MailDkimKeyStore {
  readonly #keys = new Map<string, MailDkimKeyRecord>();
  #seq = 0;

  constructor(private readonly now: () => Date = () => new Date("2026-05-21T00:00:00.000Z")) {}

  async listKeys(orgId: string, domainId: string): Promise<readonly MailDkimKeyRecord[]> {
    return [...this.#keys.values()]
      .filter((key) => key.orgId === orgId && key.domainId === domainId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async generateKey(input: {
    readonly orgId: string;
    readonly domainId: string;
    readonly selector: string;
    readonly domain: string;
    readonly keyBits?: number;
    readonly createdBy: string;
  }): Promise<MailDkimKeyRecord> {
    const clash = [...this.#keys.values()].some(
      (key) =>
        key.domainId === input.domainId &&
        key.selector.toLowerCase() === input.selector.toLowerCase(),
    );
    if (clash) {
      throw new MailAdminConflictError(
        `A DKIM key with selector "${input.selector}" already exists for this domain.`,
      );
    }
    const timestamp = isoNow(this.now);
    for (const key of this.#keys.values()) {
      if (key.orgId === input.orgId && key.domainId === input.domainId && key.status === "active") {
        this.#keys.set(key.id, { ...key, status: "retiring", rotatedAt: timestamp });
      }
    }
    const keyBits = input.keyBits ?? 2048;
    const material = generateDkimKeyMaterial(keyBits);
    this.#seq += 1;
    const key: MailDkimKeyRecord = {
      id: genId(this.#seq),
      orgId: input.orgId,
      domainId: input.domainId,
      selector: input.selector,
      status: "active",
      algorithm: "rsa-sha256",
      keyBits,
      privateKeyPem: material.privateKeyPem,
      publicKeyPem: material.publicKeyPem,
      dnsRecord: dkimDnsRecord(material.dnsPublicKey),
      rotatedAt: null,
      retiredAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#keys.set(key.id, key);
    return key;
  }

  async retireKey(orgId: string, id: string): Promise<MailDkimKeyRecord | null> {
    const key = this.#keys.get(id);
    if (key === undefined || key.orgId !== orgId || key.status === "retired") {
      return null;
    }
    const timestamp = isoNow(this.now);
    const updated: MailDkimKeyRecord = {
      ...key,
      status: "retired",
      retiredAt: timestamp,
      updatedAt: timestamp,
    };
    this.#keys.set(updated.id, updated);
    return updated;
  }
}

export class InMemoryMailDmarcReportStore implements MailDmarcReportStore {
  readonly #reports = new Map<string, MailDmarcReportRecord>();
  readonly #records = new Map<string, readonly MailDmarcReportRowRecord[]>();
  #seq = 0;

  constructor(private readonly now: () => Date = () => new Date("2026-05-21T00:00:00.000Z")) {}

  async ingestReport(input: IngestDmarcReportInput): Promise<MailDmarcReportRecord> {
    const totals = aggregateDmarcRecords(input.records);
    const existing = [...this.#reports.values()].find(
      (report) =>
        report.orgId === input.orgId &&
        report.domain === input.domain.toLowerCase() &&
        report.orgName === input.orgName &&
        report.reportId === input.reportId,
    );
    const id =
      existing?.id ??
      (() => {
        this.#seq += 1;
        return genId(this.#seq);
      })();
    const report: MailDmarcReportRecord = {
      id,
      orgId: input.orgId,
      domain: input.domain.toLowerCase(),
      orgName: input.orgName,
      reportId: input.reportId,
      dateRangeBegin: input.dateRangeBegin.toISOString(),
      dateRangeEnd: input.dateRangeEnd.toISOString(),
      policyP: input.policyP,
      policySp: input.policySp,
      policyPct: input.policyPct,
      totalMessages: totals.total,
      passMessages: totals.pass,
      failMessages: totals.fail,
      createdAt: existing?.createdAt ?? isoNow(this.now),
    };
    this.#reports.set(id, report);
    this.#records.set(id, input.records);
    return report;
  }

  async listReports(orgId: string, domain?: string): Promise<readonly MailDmarcReportRecord[]> {
    return [...this.#reports.values()]
      .filter(
        (report) =>
          report.orgId === orgId &&
          (domain === undefined || report.domain === domain.toLowerCase()),
      )
      .sort((a, b) => b.dateRangeEnd.localeCompare(a.dateRangeEnd));
  }

  async getSummary(orgId: string, domain: string): Promise<MailDmarcSummary> {
    const reports = await this.listReports(orgId, domain);
    let totalMessages = 0;
    let passMessages = 0;
    const bySource = new Map<string, number>();
    for (const report of reports) {
      totalMessages += report.totalMessages;
      passMessages += report.passMessages;
      for (const record of this.#records.get(report.id) ?? []) {
        if (record.dkimResult !== "pass" && record.spfResult !== "pass") {
          bySource.set(record.sourceIp, (bySource.get(record.sourceIp) ?? 0) + record.messageCount);
        }
      }
    }
    return {
      domain: domain.toLowerCase(),
      totalMessages,
      passMessages,
      failMessages: totalMessages - passMessages,
      passRate: totalMessages === 0 ? 1 : passMessages / totalMessages,
      reportCount: reports.length,
      topFailingSources: [...bySource.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([sourceIp, messageCount]) => ({ sourceIp, messageCount })),
    };
  }
}

export class InMemoryMailRoutingRuleStore implements MailRoutingRuleStore {
  readonly #rules = new Map<string, MailRoutingRuleRecord>();
  #seq = 0;

  constructor(private readonly now: () => Date = () => new Date("2026-05-21T00:00:00.000Z")) {}

  async listRules(orgId: string): Promise<readonly MailRoutingRuleRecord[]> {
    return [...this.#rules.values()]
      .filter((rule) => rule.orgId === orgId)
      .sort((a, b) =>
        a.priority === b.priority
          ? a.createdAt.localeCompare(b.createdAt)
          : a.priority - b.priority,
      );
  }

  async getRule(orgId: string, id: string): Promise<MailRoutingRuleRecord | null> {
    const rule = this.#rules.get(id);
    return rule === undefined || rule.orgId !== orgId ? null : rule;
  }

  async createRule(input: CreateRoutingRuleInput): Promise<MailRoutingRuleRecord> {
    const clash = [...this.#rules.values()].some(
      (rule) => rule.orgId === input.orgId && rule.name.toLowerCase() === input.name.toLowerCase(),
    );
    if (clash) {
      throw new MailAdminConflictError(`A routing rule named "${input.name}" already exists.`);
    }
    this.#seq += 1;
    const timestamp = isoNow(this.now);
    const rule: MailRoutingRuleRecord = {
      id: genId(this.#seq),
      orgId: input.orgId,
      name: input.name,
      isEnabled: input.isEnabled,
      priority: input.priority,
      match: input.match,
      actionKind: input.actionKind,
      action: input.action,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#rules.set(rule.id, rule);
    return rule;
  }

  async updateRule(input: UpdateRoutingRuleInput): Promise<MailRoutingRuleRecord | null> {
    const current = this.#rules.get(input.id);
    if (current === undefined || current.orgId !== input.orgId) {
      return null;
    }
    const updated: MailRoutingRuleRecord = {
      ...current,
      name: input.name ?? current.name,
      isEnabled: input.isEnabled ?? current.isEnabled,
      priority: input.priority ?? current.priority,
      match: input.match ?? current.match,
      actionKind: input.actionKind ?? current.actionKind,
      action: input.action ?? current.action,
      updatedAt: isoNow(this.now),
    };
    this.#rules.set(updated.id, updated);
    return updated;
  }

  async deleteRule(orgId: string, id: string): Promise<boolean> {
    const rule = this.#rules.get(id);
    if (rule === undefined || rule.orgId !== orgId) {
      return false;
    }
    this.#rules.delete(id);
    return true;
  }
}

/** Random token used to seed a `secret_ref` env-var name placeholder in tests. */
export function randomSecretRef(prefix = "MAIL_PROVIDER_SECRET"): string {
  return `${prefix}_${randomBytes(6).toString("hex").toUpperCase()}`;
}
