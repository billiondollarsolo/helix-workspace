import type postgres from "postgres";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  adminConsoleReadScope,
  adminConsoleWriteScope,
  auditAdminAction,
  canReadAdminConsole,
  canWriteAdminConsole,
  invalidRequest,
  notFound,
  sendForbidden,
  type AdminConsoleAuditSink,
} from "./console-shared.js";

/**
 * Admin Console — Security policies.
 *
 * One record per (org, policyType) covering the six controls the Security
 * section of the Admin Console surfaces:
 *
 *   mfa | sso | session | external_sharing | dlp | device_trust
 *
 * `settings` is a typed JSON blob whose shape is validated per policy type.
 * Tier-config enforcement (audit shipping, Vault/SIEM) lives elsewhere and is
 * unaffected; these records hold the org-author-editable policy state and are
 * advisory to that enforcement. The store seeds a default record for each type
 * the first time an org's policies are listed so the UI always has six cards.
 */

export type SecurityPolicyType =
  | "mfa"
  | "sso"
  | "session"
  | "external_sharing"
  | "dlp"
  | "device_trust";

export type PolicyEnforcement = "disabled" | "optional" | "required";

export const SECURITY_POLICY_TYPES: readonly SecurityPolicyType[] = [
  "mfa",
  "sso",
  "session",
  "external_sharing",
  "dlp",
  "device_trust",
];

export interface SecurityPolicyRecord {
  readonly id: string;
  readonly orgId: string;
  readonly policyType: SecurityPolicyType;
  readonly enabled: boolean;
  readonly enforcement: PolicyEnforcement;
  readonly settings: Record<string, unknown>;
  readonly updatedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// --------------------------------------------------------------------------
// Per-type settings schemas
// --------------------------------------------------------------------------

const mfaSettings = z
  .object({
    allowedMethods: z
      .array(z.enum(["hardware_key", "totp", "sms"]))
      .max(3)
      .default(["hardware_key", "totp"]),
    rememberDeviceDays: z.number().int().min(0).max(90).default(0),
  })
  .strict();

const ssoSettings = z
  .object({
    provider: z.enum(["okta", "azure_ad", "google", "generic_saml", "none"]).default("none"),
    metadataUrl: z.string().trim().url().max(2000).nullable().default(null),
    jitProvisioning: z.boolean().default(false),
    mappedDomains: z.array(z.string().trim().min(1).max(253)).max(50).default([]),
  })
  .strict();

const sessionSettings = z
  .object({
    inactivityTimeoutDays: z.number().int().min(1).max(90).default(14),
    reauthForAdminActions: z.boolean().default(true),
    maxConcurrentSessions: z.number().int().min(1).max(50).default(10),
  })
  .strict();

const externalSharingSettings = z
  .object({
    mode: z.enum(["blocked", "allowlist", "anyone"]).default("allowlist"),
    allowedDomains: z.array(z.string().trim().min(1).max(253)).max(200).default([]),
    requireExpiry: z.boolean().default(false),
  })
  .strict();

const dlpSettings = z
  .object({
    detectors: z
      .array(z.enum(["pii", "credentials", "credit_card", "source_code"]))
      .max(4)
      .default(["pii", "credentials", "credit_card"]),
    action: z.enum(["audit", "warn", "block"]).default("warn"),
    scanOutboundMail: z.boolean().default(true),
    scanSharedDocs: z.boolean().default(true),
  })
  .strict();

const deviceTrustSettings = z
  .object({
    requireManagedDevice: z.boolean().default(false),
    protectedApps: z.array(z.enum(["drive", "mail", "docs", "calendar"])).max(4).default([]),
    allowUnenrolledGraceDays: z.number().int().min(0).max(30).default(0),
  })
  .strict();

const settingsSchemaByType: Record<SecurityPolicyType, z.ZodTypeAny> = {
  mfa: mfaSettings,
  sso: ssoSettings,
  session: sessionSettings,
  external_sharing: externalSharingSettings,
  dlp: dlpSettings,
  device_trust: deviceTrustSettings,
};

/** Parse and normalize a policy's `settings` blob against its typed schema. */
export function parsePolicySettings(
  policyType: SecurityPolicyType,
  value: unknown,
): { readonly ok: true; readonly settings: Record<string, unknown> } | { readonly ok: false; readonly issues: unknown } {
  const schema = settingsSchemaByType[policyType];
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues };
  }
  return { ok: true, settings: parsed.data as Record<string, unknown> };
}

/** Default record for a policy type before an admin has edited it. */
export function defaultPolicy(
  policyType: SecurityPolicyType,
): Pick<SecurityPolicyRecord, "policyType" | "enabled" | "enforcement" | "settings"> {
  const parsed = parsePolicySettings(policyType, {});
  const settings = parsed.ok ? parsed.settings : {};
  return { policyType, enabled: false, enforcement: "optional", settings };
}

// --------------------------------------------------------------------------
// Store
// --------------------------------------------------------------------------

export interface UpsertSecurityPolicyInput {
  readonly orgId: string;
  readonly policyType: SecurityPolicyType;
  readonly enabled: boolean;
  readonly enforcement: PolicyEnforcement;
  readonly settings: Record<string, unknown>;
  readonly updatedBy: string;
}

export interface SecurityPoliciesStore {
  /** List all six policy records, materializing defaults for any missing. */
  list(orgId: string): Promise<readonly SecurityPolicyRecord[]>;
  get(orgId: string, policyType: SecurityPolicyType): Promise<SecurityPolicyRecord | null>;
  upsert(input: UpsertSecurityPolicyInput): Promise<SecurityPolicyRecord>;
}

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

const enforcementSchema = z.enum(["disabled", "optional", "required"]);
const policyTypeSchema = z.enum([
  "mfa",
  "sso",
  "session",
  "external_sharing",
  "dlp",
  "device_trust",
]);

const updatePolicyBody = z
  .object({
    enabled: z.boolean().optional(),
    enforcement: enforcementSchema.optional(),
    settings: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided.",
  });

export interface RegisterAdminSecurityPoliciesRoutesOptions {
  readonly store: SecurityPoliciesStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly auditSink?: AdminConsoleAuditSink | undefined;
}

/**
 * Register the Security policies admin routes:
 *
 *   GET   /api/admin/security-policies
 *   GET   /api/admin/security-policies/:policyType
 *   PUT   /api/admin/security-policies/:policyType
 */
export async function registerAdminSecurityPoliciesRoutes(
  app: FastifyInstance,
  options: RegisterAdminSecurityPoliciesRoutesOptions,
): Promise<void> {
  const { store, actorFromRequest, auditSink } = options;

  app.get("/api/admin/security-policies", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    return { policies: await store.list(actor.orgId) };
  });

  app.get("/api/admin/security-policies/:policyType", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const params = z.object({ policyType: policyTypeSchema }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Unknown security policy type."));
    }
    const policy = await store.get(actor.orgId, params.data.policyType);
    if (policy === null) {
      return reply.code(404).send(notFound("Security policy not found."));
    }
    return { policy };
  });

  app.put("/api/admin/security-policies/:policyType", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = z.object({ policyType: policyTypeSchema }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Unknown security policy type."));
    }
    const body = updatePolicyBody.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid security policy update.", body.error.issues));
    }

    const policyType = params.data.policyType;
    const current =
      (await store.get(actor.orgId, policyType)) ?? {
        ...defaultPolicy(policyType),
        id: "",
        orgId: actor.orgId,
        updatedBy: null,
        createdAt: "",
        updatedAt: "",
      };

    const settingsInput = body.data.settings ?? current.settings;
    const parsedSettings = parsePolicySettings(policyType, settingsInput);
    if (!parsedSettings.ok) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid security policy settings.", parsedSettings.issues));
    }

    const policy = await store.upsert({
      orgId: actor.orgId,
      policyType,
      enabled: body.data.enabled ?? current.enabled,
      enforcement: body.data.enforcement ?? current.enforcement,
      settings: parsedSettings.settings,
      updatedBy: actor.id,
    });

    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.security_policy.updated",
      objectType: "admin_security_policy",
      objectId: policy.id,
      metadata: {
        policyType,
        enabled: policy.enabled,
        enforcement: policy.enforcement,
        fields: Object.keys(body.data),
      },
    });
    return { policy };
  });
}

// --------------------------------------------------------------------------
// Postgres store
// --------------------------------------------------------------------------

interface SecurityPolicyRow {
  readonly id: string;
  readonly org_id: string;
  readonly policy_type: SecurityPolicyType;
  readonly enabled: boolean;
  readonly enforcement: PolicyEnforcement;
  readonly settings: unknown;
  readonly updated_by: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PostgresSecurityPoliciesStore implements SecurityPoliciesStore {
  constructor(private readonly sql: postgres.Sql) {}

  async list(orgId: string): Promise<readonly SecurityPolicyRecord[]> {
    const rows = (await this.sql`
      select id, org_id, policy_type, enabled, enforcement, settings,
             updated_by, created_at, updated_at
      from admin_security_policies
      where org_id = ${orgId}
    `) as unknown as readonly SecurityPolicyRow[];
    const byType = new Map(rows.map((row) => [row.policy_type, mapPolicyRow(row)]));
    return SECURITY_POLICY_TYPES.map((policyType) => {
      const existing = byType.get(policyType);
      if (existing !== undefined) {
        return existing;
      }
      const fallback = defaultPolicy(policyType);
      return {
        id: `default:${policyType}`,
        orgId,
        policyType,
        enabled: fallback.enabled,
        enforcement: fallback.enforcement,
        settings: fallback.settings,
        updatedBy: null,
        createdAt: "",
        updatedAt: "",
      } satisfies SecurityPolicyRecord;
    });
  }

  async get(orgId: string, policyType: SecurityPolicyType): Promise<SecurityPolicyRecord | null> {
    const rows = (await this.sql`
      select id, org_id, policy_type, enabled, enforcement, settings,
             updated_by, created_at, updated_at
      from admin_security_policies
      where org_id = ${orgId} and policy_type = ${policyType}
    `) as unknown as readonly SecurityPolicyRow[];
    const row = rows[0];
    return row === undefined ? null : mapPolicyRow(row);
  }

  async upsert(input: UpsertSecurityPolicyInput): Promise<SecurityPolicyRecord> {
    const rows = (await this.sql`
      insert into admin_security_policies
        (org_id, policy_type, enabled, enforcement, settings, updated_by)
      values
        (${input.orgId}, ${input.policyType}, ${input.enabled}, ${input.enforcement},
         ${this.sql.json(input.settings as Record<string, never>)}, ${input.updatedBy})
      on conflict (org_id, policy_type) do update set
        enabled = excluded.enabled,
        enforcement = excluded.enforcement,
        settings = excluded.settings,
        updated_by = excluded.updated_by,
        updated_at = now()
      returning id, org_id, policy_type, enabled, enforcement, settings,
                updated_by, created_at, updated_at
    `) as unknown as readonly SecurityPolicyRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Failed to upsert security policy.");
    }
    return mapPolicyRow(row);
  }
}

function mapPolicyRow(row: SecurityPolicyRow): SecurityPolicyRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    policyType: row.policy_type,
    enabled: row.enabled,
    enforcement: row.enforcement,
    settings:
      typeof row.settings === "object" && row.settings !== null && !Array.isArray(row.settings)
        ? (row.settings as Record<string, unknown>)
        : {},
    updatedBy: row.updated_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// --------------------------------------------------------------------------
// In-memory store (tests / offline)
// --------------------------------------------------------------------------

/** Deterministic in-memory {@link SecurityPoliciesStore}. */
export class InMemorySecurityPoliciesStore implements SecurityPoliciesStore {
  readonly #records = new Map<string, SecurityPolicyRecord>();
  #seq = 0;

  constructor(private readonly options: { readonly now?: () => Date } = {}) {}

  #now(): string {
    return (this.options.now ?? (() => new Date("2026-05-21T00:00:00.000Z")))().toISOString();
  }

  #key(orgId: string, policyType: SecurityPolicyType): string {
    return `${orgId}:${policyType}`;
  }

  async list(orgId: string): Promise<readonly SecurityPolicyRecord[]> {
    return SECURITY_POLICY_TYPES.map((policyType) => {
      const existing = this.#records.get(this.#key(orgId, policyType));
      if (existing !== undefined) {
        return existing;
      }
      const fallback = defaultPolicy(policyType);
      return {
        id: `default:${policyType}`,
        orgId,
        policyType,
        enabled: fallback.enabled,
        enforcement: fallback.enforcement,
        settings: fallback.settings,
        updatedBy: null,
        createdAt: "",
        updatedAt: "",
      } satisfies SecurityPolicyRecord;
    });
  }

  async get(orgId: string, policyType: SecurityPolicyType): Promise<SecurityPolicyRecord | null> {
    return this.#records.get(this.#key(orgId, policyType)) ?? null;
  }

  async upsert(input: UpsertSecurityPolicyInput): Promise<SecurityPolicyRecord> {
    const key = this.#key(input.orgId, input.policyType);
    const existing = this.#records.get(key);
    const now = this.#now();
    let id = existing?.id;
    if (id === undefined) {
      this.#seq += 1;
      id = `00000000-0000-4000-9000-${this.#seq.toString(16).padStart(12, "0")}`;
    }
    const record: SecurityPolicyRecord = {
      id,
      orgId: input.orgId,
      policyType: input.policyType,
      enabled: input.enabled,
      enforcement: input.enforcement,
      settings: input.settings,
      updatedBy: input.updatedBy,
      createdAt: existing?.createdAt !== undefined && existing.createdAt !== "" ? existing.createdAt : now,
      updatedAt: now,
    };
    this.#records.set(key, record);
    return record;
  }
}
