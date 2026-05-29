import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";

export type SignupOnboardingPlanChoice = "pro-trial" | "personal" | "sales";
export type SignupOnboardingIdentityChoice =
  | "local"
  | "google"
  | "microsoft"
  | "okta"
  | "oidc"
  | "saml";
export type SignupOnboardingStep = "plan" | "invite" | "sso";
export type SignupOnboardingSsoProvider = Exclude<SignupOnboardingIdentityChoice, "local">;
export type SignupOnboardingSsoPolicyProvider =
  | "google"
  | "azure_ad"
  | "okta"
  | "generic_oidc"
  | "generic_saml";
export type SignupOnboardingSsoTestStatus = "configuration_required" | "runtime_pending";

export interface SignupOnboardingSsoTestResult {
  readonly status: SignupOnboardingSsoTestStatus;
  readonly message: string;
}

export interface PersistSignupOnboardingCompletionInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly planChoice?: SignupOnboardingPlanChoice;
  readonly inviteCount?: number;
  readonly identityChoice?: SignupOnboardingIdentityChoice;
  readonly skipped?: boolean;
  readonly completedAt?: Date;
}

export interface PersistSignupOnboardingProgressInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly currentStep: SignupOnboardingStep;
  readonly planChoice?: SignupOnboardingPlanChoice;
  readonly inviteCount?: number;
  readonly identityChoice?: SignupOnboardingIdentityChoice;
  readonly updatedAt?: Date;
}

export interface SignupOnboardingState {
  readonly status: "not_started" | "in_progress" | "completed";
  readonly currentStep: SignupOnboardingStep;
  readonly planChoice: SignupOnboardingPlanChoice;
  readonly inviteCount: number;
  readonly identityChoice: SignupOnboardingIdentityChoice;
  readonly skipped?: boolean;
  readonly updatedAt?: string;
  readonly completedAt?: string;
}

export interface SignupOnboardingStore {
  getState?(orgId: string): Promise<SignupOnboardingState>;
  persistProgress?(input: PersistSignupOnboardingProgressInput): Promise<void>;
  persistCompletion(input: PersistSignupOnboardingCompletionInput): Promise<void>;
  persistSsoConfig?(input: PersistSignupOnboardingSsoConfigInput): Promise<void>;
}

export interface PersistSignupOnboardingSsoConfigInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly provider: SignupOnboardingSsoProvider;
  readonly metadataUrl?: string | null;
  readonly mappedDomains?: readonly string[];
  readonly jitProvisioning?: boolean;
  readonly testLogin?: SignupOnboardingSsoTestResult;
  readonly configuredAt?: Date;
}

export class PostgresSignupOnboardingStore implements SignupOnboardingStore {
  constructor(private readonly sql: postgres.Sql) {}

  async getState(orgId: string): Promise<SignupOnboardingState> {
    const rows = (await this.sql`
      select metadata -> 'onboarding' as onboarding
      from orgs
      where id = ${orgId}
      limit 1
    `) as unknown as readonly { readonly onboarding: unknown }[];
    return onboardingStateFromJson(rows[0]?.onboarding);
  }

  async persistProgress(input: PersistSignupOnboardingProgressInput): Promise<void> {
    const updatedAt = input.updatedAt ?? new Date();
    const onboarding = onboardingJson({
      status: "in_progress",
      source: "signup",
      currentStep: input.currentStep,
      updatedAt: updatedAt.toISOString(),
      ...(input.planChoice === undefined ? {} : { planChoice: input.planChoice }),
      ...(input.inviteCount === undefined ? {} : { inviteCount: input.inviteCount }),
      ...(input.identityChoice === undefined ? {} : { identityChoice: input.identityChoice }),
    });

    await this.sql`
      with previous as (
        select metadata
        from orgs
        where id = ${input.orgId}
        for update
      ),
      updated as (
        update orgs
        set
          metadata = jsonb_set(metadata, '{onboarding}', ${this.sql.json(onboarding)}::jsonb, true),
          updated_at = now()
        where id = ${input.orgId}
        returning id
      )
      insert into tenant_config_audit (
        org_id,
        key,
        old_value,
        new_value,
        changed_by,
        reason
      )
      select
        ${input.orgId},
        'signup.onboarding.progress',
        previous.metadata->'onboarding',
        ${this.sql.json(onboarding)}::jsonb,
        ${uuidOrNull(input.actorId)}::uuid,
        'signup onboarding progress'
      from previous
      where exists (select 1 from updated)
    `;
  }

  async persistCompletion(input: PersistSignupOnboardingCompletionInput): Promise<void> {
    const completedAt = input.completedAt ?? new Date();
    const planId = planIdForChoice(input.planChoice);
    const onboarding = onboardingJson({
      status: "completed",
      source: "signup",
      currentStep: "sso",
      completedAt: completedAt.toISOString(),
      ...(input.planChoice === undefined ? {} : { planChoice: input.planChoice }),
      ...(input.inviteCount === undefined ? {} : { inviteCount: input.inviteCount }),
      ...(input.identityChoice === undefined ? {} : { identityChoice: input.identityChoice }),
      ...(input.skipped === undefined ? {} : { skipped: input.skipped }),
    });

    await this.sql`
      with previous as (
        select plan_id, metadata
        from orgs
        where id = ${input.orgId}
        for update
      ),
      updated as (
        update orgs
        set
          plan_id = coalesce(${planId}, plan_id),
          metadata = jsonb_set(metadata, '{onboarding}', ${this.sql.json(onboarding)}::jsonb, true),
          updated_at = now()
        where id = ${input.orgId}
        returning id
      )
      insert into tenant_config_audit (
        org_id,
        key,
        old_value,
        new_value,
        changed_by,
        reason
      )
      select
        ${input.orgId},
        'signup.onboarding',
        jsonb_build_object(
          'planId', previous.plan_id,
          'onboarding', previous.metadata->'onboarding'
        ),
        jsonb_build_object(
          'planId', coalesce(${planId}, previous.plan_id),
          'onboarding', ${this.sql.json(onboarding)}::jsonb
        ),
        ${uuidOrNull(input.actorId)}::uuid,
        'signup onboarding completion'
      from previous
      where exists (select 1 from updated)
    `;

    if (input.identityChoice !== undefined && input.identityChoice !== "local") {
      await this.persistSsoConfig({
        orgId: input.orgId,
        actorId: input.actorId,
        provider: input.identityChoice,
        testLogin: testSignupOnboardingSsoConfig({ provider: input.identityChoice }),
        configuredAt: completedAt,
      });
    }
  }

  async persistSsoConfig(input: PersistSignupOnboardingSsoConfigInput): Promise<void> {
    const configuredAt = input.configuredAt ?? new Date();
    const testLogin = input.testLogin ?? testSignupOnboardingSsoConfig(input);
    const settings: JsonObject = {
      provider: policyProviderForSignupSso(input.provider),
      metadataUrl: normalizedMetadataUrl(input.metadataUrl),
      jitProvisioning: input.jitProvisioning ?? true,
      mappedDomains: normalizeMappedDomains(input.mappedDomains),
      localLoginEnabled: true,
      setupStatus: "draft",
      testLoginStatus: testLogin.status,
      setupSource: "signup",
      configuredAt: configuredAt.toISOString(),
    };

    await this.sql`
      with previous as (
        select enabled, enforcement, settings
        from admin_security_policies
        where org_id = ${input.orgId}
          and policy_type = 'sso'
        for update
      ),
      upserted as (
        insert into admin_security_policies (
          org_id,
          policy_type,
          enabled,
          enforcement,
          settings,
          updated_by
        )
        values (
          ${input.orgId},
          'sso',
          false,
          'optional',
          ${this.sql.json(settings)},
          ${uuidOrNull(input.actorId)}::uuid
        )
        on conflict (org_id, policy_type) do update
        set
          enabled = excluded.enabled,
          enforcement = excluded.enforcement,
          settings = excluded.settings,
          updated_by = excluded.updated_by,
          updated_at = now()
        returning id
      )
      insert into tenant_config_audit (
        org_id,
        key,
        old_value,
        new_value,
        changed_by,
        reason
      )
      select
        ${input.orgId},
        'signup.sso',
        jsonb_build_object(
          'enabled', previous.enabled,
          'enforcement', previous.enforcement,
          'settings', previous.settings
        ),
        jsonb_build_object(
          'enabled', false,
          'enforcement', 'optional',
          'settings', ${this.sql.json(settings)}::jsonb
        ),
        ${uuidOrNull(input.actorId)}::uuid,
        'signup onboarding sso draft'
      from upserted
      left join previous on true
    `;
  }
}

export function planIdForChoice(choice: SignupOnboardingPlanChoice | undefined): string | null {
  if (choice === "personal") {
    return "personal";
  }
  if (choice === "sales") {
    return null;
  }
  return "pro";
}

export function signupOnboardingIdentityAllowedForPlan(
  planChoice: SignupOnboardingPlanChoice | undefined,
  identityChoice: SignupOnboardingIdentityChoice | undefined,
): boolean {
  if (identityChoice === undefined || identityChoice === "local") {
    return true;
  }
  if (planChoice === undefined || planChoice === "personal") {
    return false;
  }
  if (planChoice === "pro-trial") {
    return identityChoice === "google" || identityChoice === "microsoft";
  }
  return true;
}

export function testSignupOnboardingSsoConfig(input: {
  readonly provider: SignupOnboardingSsoProvider;
  readonly metadataUrl?: string | null;
}): SignupOnboardingSsoTestResult {
  if (requiresMetadataUrl(input.provider) && normalizedMetadataUrl(input.metadataUrl) === null) {
    return {
      status: "configuration_required",
      message: "Provider metadata is required before SSO can be tested.",
    };
  }
  return {
    status: "runtime_pending",
    message: "Provider settings are valid; SSO login runtime is not connected yet.",
  };
}

export function policyProviderForSignupSso(
  provider: SignupOnboardingSsoProvider,
): SignupOnboardingSsoPolicyProvider {
  if (provider === "microsoft") {
    return "azure_ad";
  }
  if (provider === "oidc") {
    return "generic_oidc";
  }
  if (provider === "saml") {
    return "generic_saml";
  }
  return provider;
}

function requiresMetadataUrl(provider: SignupOnboardingSsoProvider): boolean {
  return provider === "okta" || provider === "oidc" || provider === "saml";
}

function normalizedMetadataUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeMappedDomains(values: readonly string[] | undefined): readonly string[] {
  return [
    ...new Set(
      (values ?? []).map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0),
    ),
  ].slice(0, 10);
}

function onboardingJson(input: JsonObject): JsonObject {
  return {
    status: "in_progress",
    source: "signup",
    currentStep: "plan",
    planChoice: "pro-trial",
    inviteCount: 0,
    identityChoice: "local",
    ...input,
  };
}

function onboardingStateFromJson(value: unknown): SignupOnboardingState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return defaultOnboardingState();
  }
  const record = value as Record<string, unknown>;
  const status =
    record.status === "in_progress" || record.status === "completed"
      ? record.status
      : "not_started";
  return {
    status,
    currentStep: onboardingStep(record.currentStep),
    planChoice: onboardingPlanChoice(record.planChoice),
    inviteCount:
      typeof record.inviteCount === "number" &&
      Number.isInteger(record.inviteCount) &&
      record.inviteCount >= 0
        ? Math.min(record.inviteCount, 10)
        : 0,
    identityChoice: onboardingIdentityChoice(record.identityChoice),
    ...(typeof record.skipped === "boolean" ? { skipped: record.skipped } : {}),
    ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
    ...(typeof record.completedAt === "string" ? { completedAt: record.completedAt } : {}),
  };
}

function defaultOnboardingState(): SignupOnboardingState {
  return {
    status: "not_started",
    currentStep: "plan",
    planChoice: "pro-trial",
    inviteCount: 0,
    identityChoice: "local",
  };
}

function onboardingStep(value: unknown): SignupOnboardingStep {
  return value === "invite" || value === "sso" ? value : "plan";
}

function onboardingPlanChoice(value: unknown): SignupOnboardingPlanChoice {
  return value === "personal" || value === "sales" ? value : "pro-trial";
}

function onboardingIdentityChoice(value: unknown): SignupOnboardingIdentityChoice {
  return value === "google" ||
    value === "microsoft" ||
    value === "okta" ||
    value === "oidc" ||
    value === "saml"
    ? value
    : "local";
}

function uuidOrNull(value: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ? value
    : null;
}
