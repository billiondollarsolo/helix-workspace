import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";

export type SignupOnboardingPlanChoice = "pro-trial" | "personal" | "sales";
export type SignupOnboardingIdentityChoice = "local";
export type SignupOnboardingStep = "plan" | "invite" | "sso";

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
}

export class PostgresSignupOnboardingStore implements SignupOnboardingStore {
  constructor(private readonly sql: postgres.Sql) {}

  async getState(orgId: string): Promise<SignupOnboardingState> {
    const rows = await this.sql<{ readonly onboarding: unknown }[]>`
      select metadata -> 'onboarding' as onboarding
      from orgs
      where id = ${orgId}
      limit 1
    `;
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

function onboardingIdentityChoice(_value: unknown): SignupOnboardingIdentityChoice {
  return "local";
}

function uuidOrNull(value: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ? value
    : null;
}
