import type { Actor, SecurityTier } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import {
  resolveAdminSecurityControls,
  type AdminSecurityControls,
} from "../auth/admin-security-policy.js";
import type { MfaVerificationResolver } from "../auth/mfa.js";
import { parseActorRoleBindings } from "../permissions/roles.js";
import { dlpBoundaries } from "../dlp.js";
import { driveWorkflowKinds } from "../drive/workflows.js";
import {
  adminConsoleReadScope,
  adminConsoleWriteScope,
  auditAdminAction,
  canReadAdminConsole,
  canWriteAdminConsole,
  invalidRequest,
  sendForbidden,
  type AdminConsoleAuditSink,
} from "./console-shared.js";
import {
  policyRuntimeStatus,
  validateRecordedOnlyRequiredEnforcement,
  type PolicyRuntimeStatusView,
} from "./security-policy-runtime.js";

/**
 * Admin Console — Security policies.
 *
 * One record per (org, policyType) covering the controls the Security
 * section of the Admin Console surfaces:
 *
 *   mfa | sso | session | external_sharing | dlp | device_trust | drive_workflows
 *
 * `settings` is a typed JSON blob whose shape is validated per policy type.
 * Tier-config enforcement (audit shipping, Vault/SIEM) lives elsewhere and is
 * unaffected. Runtime consumers read each tenant policy; list/get synthesize
 * defaults without writing or converting inherited controls to explicit choices.
 */

export type SecurityPolicyType =
  "mfa" | "sso" | "session" | "external_sharing" | "dlp" | "device_trust" | "drive_workflows";

type PolicyEnforcement = "disabled" | "optional" | "required";

export const SECURITY_POLICY_TYPES: readonly SecurityPolicyType[] = [
  "mfa",
  "sso",
  "session",
  "external_sharing",
  "dlp",
  "device_trust",
  "drive_workflows",
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

export type SecurityPolicyView = SecurityPolicyRecord & {
  readonly runtimeStatus: PolicyRuntimeStatusView;
  readonly effectiveControls?: AdminSecurityControls;
};

function toPolicyView(
  policy: SecurityPolicyRecord,
  tier: SecurityTier = "personal",
): SecurityPolicyView {
  const effectiveControls =
    policy.policyType === "mfa" ? resolveAdminSecurityControls(tier, policy) : undefined;
  const active =
    effectiveControls !== undefined &&
    (effectiveControls.adminMfaRequired ||
      effectiveControls.sensitiveActionMfaRequired ||
      effectiveControls.secondAdminApprovalRequired);
  return {
    ...policy,
    runtimeStatus: {
      ...policyRuntimeStatus(policy),
      ...(effectiveControls === undefined
        ? {}
        : {
            displayLevel: active ? ("active" as const) : ("off" as const),
            displayLevelOn: active,
          }),
    },
    ...(effectiveControls === undefined ? {} : { effectiveControls }),
  };
}

// --------------------------------------------------------------------------
// Per-type settings schemas
// --------------------------------------------------------------------------

const mfaSettings = z
  .object({
    // Absence means inherited; do not materialize defaults as explicit operator choices.
    adminMfa: z.enum(["tier_default", "optional", "required"]).optional(),
    sensitiveActionMfaRequired: z.boolean().optional(),
    secondAdminApprovalRequired: z.boolean().optional(),
    allowedMethods: z
      .array(z.enum(["hardware_key", "totp", "sms"]))
      .max(3)
      .default(["hardware_key", "totp"]),
    rememberDeviceDays: z.number().int().min(0).max(90).default(0),
  })
  .strict();

const ssoSettings = z
  .object({
    provider: z.enum(["okta", "azure_ad", "google", "generic_oidc", "none"]).default("none"),
    metadataUrl: z.string().trim().url().max(2000).nullable().default(null),
    jitProvisioning: z.boolean().default(false),
    mappedDomains: z.array(z.string().trim().min(1).max(253)).max(50).default([]),
    localLoginEnabled: z.literal(true).default(true),
    setupStatus: z.enum(["none", "draft"]).default("none"),
    testLoginStatus: z.enum(["not_tested", "configuration_required"]).default("not_tested"),
    setupSource: z.enum(["admin", "signup"]).default("admin"),
  })
  .strict();

const sessionSettings = z
  .object({
    inactivityTimeoutDays: z.number().int().min(1).max(90).default(14),
    absoluteLifetimeDays: z.number().int().min(1).max(90).default(7),
    reauthForAdminActions: z.boolean().default(true),
    reauthIntervalMinutes: z.number().int().min(1).max(1440).default(10),
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
    action: z.enum(["audit", "warn", "quarantine", "block"]).default("warn"),
    boundaries: z
      .array(z.enum(dlpBoundaries))
      .max(dlpBoundaries.length)
      .default([...dlpBoundaries]),
    scanOutboundMail: z.boolean().default(true),
    scanSharedDocs: z.boolean().default(true),
  })
  .strict();

const deviceTrustSettings = z
  .object({
    requireManagedDevice: z.boolean().default(false),
    protectedApps: z
      .array(z.enum(["drive", "mail", "calendar"]))
      .max(3)
      .default([]),
    allowUnenrolledGraceDays: z.number().int().min(0).max(30).default(0),
  })
  .strict();

const driveWorkflowSettings = z
  .object({
    allowedKinds: z
      .array(z.enum(driveWorkflowKinds))
      .max(driveWorkflowKinds.length)
      .default([...driveWorkflowKinds]),
    requireDueDate: z.boolean().default(false),
  })
  .strict();

const settingsSchemaByType: Record<SecurityPolicyType, z.ZodTypeAny> = {
  mfa: mfaSettings,
  sso: ssoSettings,
  session: sessionSettings,
  external_sharing: externalSharingSettings,
  dlp: dlpSettings,
  device_trust: deviceTrustSettings,
  drive_workflows: driveWorkflowSettings,
};

/** Parse and normalize a policy's `settings` blob against its typed schema. */
export function parsePolicySettings(
  policyType: SecurityPolicyType,
  value: unknown,
):
  | { readonly ok: true; readonly settings: Record<string, unknown> }
  | { readonly ok: false; readonly issues: unknown } {
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
  /** List each policy, synthesizing defaults for any missing. */
  list(orgId: string): Promise<readonly SecurityPolicyRecord[]>;
  get(
    orgId: string,
    policyType: SecurityPolicyType,
    lockForUpdate?: boolean,
  ): Promise<SecurityPolicyRecord | null>;
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
  "drive_workflows",
]);

const updatePolicyBody = z
  .object({
    enabled: z.boolean().optional(),
    enforcement: enforcementSchema.optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided.",
  });

export interface RegisterAdminSecurityPoliciesRoutesOptions {
  readonly store: SecurityPoliciesStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly auditSink: AdminConsoleAuditSink;
  readonly mfa?: MfaVerificationResolver;
  readonly securityTier?: () => SecurityTier;
  readonly hasOtherAdministrator?: (actor: Actor) => Promise<boolean>;
}

/**
 * Register the Security policies admin routes:
 *
 *   GET   /api/admin/security-policies
 *   GET   /api/admin/security-policies/:policyType
 *   PUT   /api/admin/security-policies/:policyType
 */
/** The `GET /api/admin/security-policies` body, shared with
 *  `GET /api/admin/overview` so both serve one implementation. */
export async function readSecurityPolicies(
  store: SecurityPoliciesStore,
  orgId: string,
  tier: SecurityTier = "personal",
): Promise<{ readonly policies: readonly SecurityPolicyView[] }> {
  const policies = await store.list(orgId);
  return { policies: policies.map((policy) => toPolicyView(policy, tier)) };
}

export async function registerAdminSecurityPoliciesRoutes(
  app: FastifyInstance,
  options: RegisterAdminSecurityPoliciesRoutesOptions,
): Promise<void> {
  const { store, actorFromRequest, auditSink } = options;
  const tier = options.securityTier ?? (() => "personal" as const);

  app.get("/api/admin/security-policies", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor, "admin.security")) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    return readSecurityPolicies(store, actor.orgId, tier());
  });

  app.get("/api/admin/security-policies/:policyType", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor, "admin.security")) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const params = z.object({ policyType: policyTypeSchema }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Unknown security policy type."));
    }
    const policy = await store.get(actor.orgId, params.data.policyType);
    if (policy === null) {
      // Materialize the same defaults list/get consumers already see.
      const fallback = defaultPolicy(params.data.policyType);
      return {
        policy: toPolicyView(
          {
            id: `default:${params.data.policyType}`,
            orgId: actor.orgId,
            policyType: params.data.policyType,
            enabled: fallback.enabled,
            enforcement: fallback.enforcement,
            settings: fallback.settings,
            updatedBy: null,
            createdAt: "",
            updatedAt: "",
          },
          tier(),
        ),
      };
    }
    return { policy: toPolicyView(policy, tier()) };
  });

  app.put("/api/admin/security-policies/:policyType", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor, "admin.security")) {
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
    const current = (await store.get(actor.orgId, policyType, true)) ?? {
      ...defaultPolicy(policyType),
      id: "",
      orgId: actor.orgId,
      updatedBy: null,
      createdAt: "",
      updatedAt: "",
    };

    const nextEnforcement = body.data.enforcement ?? current.enforcement;
    const enforcementGate = validateRecordedOnlyRequiredEnforcement(policyType, nextEnforcement);
    if (!enforcementGate.ok) {
      return reply.code(400).send(invalidRequest(enforcementGate.message));
    }

    const settingsInput = { ...current.settings, ...body.data.settings };
    const parsedSettings = parsePolicySettings(policyType, settingsInput);
    if (!parsedSettings.ok) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid security policy settings.", parsedSettings.issues));
    }

    if (policyType === "mfa" || policyType === "session") {
      if (
        actor.type !== "user" ||
        !(await options.mfa?.isRecentlyAuthenticated?.(request, actor))
      ) {
        return reply.code(403).send({
          code: "security_policy_reauthentication_required",
          error:
            "Sign in again before changing authentication or approval policies (within 10 minutes).",
        });
      }
      const next = {
        enabled: body.data.enabled ?? current.enabled,
        enforcement: nextEnforcement,
        settings: parsedSettings.settings,
      };
      if (
        policyType === "mfa" &&
        body.data.settings?.secondAdminApprovalRequired === true &&
        current.settings.secondAdminApprovalRequired !== true &&
        !(await options.hasOtherAdministrator?.(actor))
      ) {
        return reply.code(409).send({
          code: "security_policy_second_admin_required",
          error:
            "Add another active human security administrator before requiring second-admin approval.",
        });
      }
      const requiresNewMfa =
        policyType === "mfa" &&
        (body.data.settings?.adminMfa === "required" ||
          body.data.settings?.sensitiveActionMfaRequired === true ||
          (next.settings.adminMfa === undefined &&
            next.enabled &&
            next.enforcement === "required" &&
            !(current.enabled && current.enforcement === "required")) ||
          (!resolveAdminSecurityControls(tier(), current).adminMfaRequired &&
            resolveAdminSecurityControls(tier(), next).adminMfaRequired));
      if (requiresNewMfa && !(await options.mfa?.isMfaVerified(request, actor))) {
        return reply.code(403).send({
          code: "security_policy_mfa_required",
          error: "Enroll and verify an MFA factor before requiring it, so you retain access.",
        });
      }
    }

    const policy = await store.upsert({
      orgId: actor.orgId,
      policyType,
      enabled: body.data.enabled ?? current.enabled,
      enforcement: enforcementGate.enforcement,
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
        runtimeMode: policyRuntimeStatus(policy).mode,
        ...(policyType === "mfa"
          ? {
              previousControls: resolveAdminSecurityControls(tier(), current),
              controls: resolveAdminSecurityControls(tier(), policy),
              changedSettings: Object.keys(body.data.settings ?? {}),
            }
          : {}),
      },
    });
    return { policy: toPolicyView(policy, tier()) };
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

  async hasOtherAdministrator(actor: Actor): Promise<boolean> {
    const rows = await this.sql<{ id: string; scopes: string[]; role_bindings: unknown }[]>`
      select candidate.id, candidate.scopes, helix_actor_role_bindings(candidate.org_id, candidate.id) role_bindings
      from actors candidate where candidate.org_id = ${actor.orgId} and candidate.id <> ${actor.id}
        and candidate.type = 'user' and helix_credential_principal_is_active(candidate.id, candidate.org_id)
    `;
    return rows.some((candidate) =>
      canWriteAdminConsole(
        {
          id: candidate.id,
          orgId: actor.orgId,
          type: "user",
          scopes: candidate.scopes,
          roleBindings: parseActorRoleBindings(candidate.role_bindings),
        },
        "admin.security",
      ),
    );
  }

  async list(orgId: string): Promise<readonly SecurityPolicyRecord[]> {
    const rows = await this.sql<SecurityPolicyRow[]>`
      select id, org_id, policy_type, enabled, enforcement, settings,
             updated_by, created_at, updated_at
      from admin_security_policies
      where org_id = ${orgId}
    `;
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

  async get(
    orgId: string,
    policyType: SecurityPolicyType,
    lockForUpdate = false,
  ): Promise<SecurityPolicyRecord | null> {
    // The request transaction holds this through validation, approval consumption, write and audit.
    if (lockForUpdate)
      await this.sql`select pg_advisory_xact_lock(hashtextextended(${orgId}::text, 195))`;

    const rows = await this.sql<SecurityPolicyRow[]>`
      select id, org_id, policy_type, enabled, enforcement, settings,
             updated_by, created_at, updated_at
      from admin_security_policies
      where org_id = ${orgId} and policy_type = ${policyType}
    `;
    const row = rows[0];
    return row === undefined ? null : mapPolicyRow(row);
  }

  async upsert(input: UpsertSecurityPolicyInput): Promise<SecurityPolicyRecord> {
    const rows = await this.sql<SecurityPolicyRow[]>`
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
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Failed to upsert security policy.");
    }
    return mapPolicyRow(row);
  }
}

function mapPolicyRow(row: SecurityPolicyRow): SecurityPolicyRecord {
  const settings = normalizedPolicySettingsForRead(row.policy_type, row.settings);
  return {
    id: row.id,
    orgId: row.org_id,
    policyType: row.policy_type,
    enabled: row.enabled,
    enforcement: row.enforcement,
    settings,
    updatedBy: row.updated_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function normalizedPolicySettingsForRead(
  policyType: SecurityPolicyType,
  value: unknown,
): Record<string, unknown> {
  const raw =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  if (policyType !== "sso" || raw.localLoginEnabled !== false) {
    return raw;
  }
  return { ...raw, localLoginEnabled: true };
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
      createdAt:
        existing?.createdAt !== undefined && existing.createdAt !== "" ? existing.createdAt : now,
      updatedAt: now,
    };
    this.#records.set(key, record);
    return record;
  }
}
