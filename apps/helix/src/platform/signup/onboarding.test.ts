import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { planIdForChoice, PostgresSignupOnboardingStore } from "./onboarding.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";

describe("planIdForChoice", () => {
  it("maps onboarding choices to active plans without granting Enterprise on sales intent", () => {
    expect(planIdForChoice("pro-trial")).toBe("pro");
    expect(planIdForChoice("personal")).toBe("personal");
    expect(planIdForChoice("sales")).toBeNull();
    expect(planIdForChoice(undefined)).toBe("pro");
  });
});

describe("PostgresSignupOnboardingStore", () => {
  it("returns default onboarding state when metadata is missing", async () => {
    const recording = createRecordingSql([{ onboarding: null }]);
    const store = new PostgresSignupOnboardingStore(recording.sql);

    await expect(store.getState(orgId)).resolves.toEqual({
      status: "not_started",
      currentStep: "plan",
      planChoice: "pro-trial",
      inviteCount: 0,
      identityChoice: "local",
    });
  });

  it("parses onboarding state with safe defaults", async () => {
    const recording = createRecordingSql([
      {
        onboarding: {
          status: "in_progress",
          currentStep: "sso",
          planChoice: "personal",
          inviteCount: 20,
          identityChoice: "google",
          updatedAt: "2026-05-24T12:00:00.000Z",
        },
      },
    ]);
    const store = new PostgresSignupOnboardingStore(recording.sql);

    await expect(store.getState(orgId)).resolves.toEqual({
      status: "in_progress",
      currentStep: "sso",
      planChoice: "personal",
      inviteCount: 10,
      identityChoice: "local",
      updatedAt: "2026-05-24T12:00:00.000Z",
    });
  });

  it("persists progress metadata without invite email contents", async () => {
    const recording = createRecordingSql();
    const store = new PostgresSignupOnboardingStore(recording.sql);

    await store.persistProgress({
      orgId,
      actorId,
      currentStep: "invite",
      planChoice: "personal",
      inviteCount: 2,
      identityChoice: "local",
      updatedAt: new Date("2026-05-24T12:00:00.000Z"),
    });

    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).toContain("update orgs");
    expect(recording.calls[0]?.text).toContain("metadata = jsonb_set");
    expect(recording.calls[0]?.text).toContain("signup.onboarding.progress");
    expect(recording.jsonValues[0]).toEqual({
      status: "in_progress",
      source: "signup",
      currentStep: "invite",
      updatedAt: "2026-05-24T12:00:00.000Z",
      planChoice: "personal",
      inviteCount: 2,
      identityChoice: "local",
    });
    expect(JSON.stringify(recording.calls)).not.toContain("ada@example.com");
  });

  it("persists completion metadata, plan choice, and an audit row", async () => {
    const recording = createRecordingSql();
    const store = new PostgresSignupOnboardingStore(recording.sql);

    await store.persistCompletion({
      orgId,
      actorId,
      planChoice: "pro-trial",
      inviteCount: 2,
      identityChoice: "local",
      skipped: false,
      completedAt: new Date("2026-05-24T12:00:00.000Z"),
    });

    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).toContain("update orgs");
    expect(recording.calls[0]?.text).toContain("plan_id = coalesce(?, plan_id)");
    expect(recording.calls[0]?.text).toContain("metadata = jsonb_set");
    expect(recording.calls[0]?.text).toContain("insert into tenant_config_audit");
    expect(recording.calls[0]?.values).toContain(orgId);
    expect(recording.calls[0]?.values).toContain("pro");
    expect(recording.calls[0]?.values).toContain(actorId);
    expect(recording.jsonValues[0]).toEqual({
      status: "completed",
      source: "signup",
      currentStep: "sso",
      completedAt: "2026-05-24T12:00:00.000Z",
      planChoice: "pro-trial",
      inviteCount: 2,
      identityChoice: "local",
      skipped: false,
    });
    expect(JSON.stringify(recording.calls)).not.toContain("ada@example.com");
  });

  it("does not write non-UUID actor ids into the audit changed_by column", async () => {
    const recording = createRecordingSql();
    const store = new PostgresSignupOnboardingStore(recording.sql);

    await store.persistCompletion({
      orgId,
      actorId: "service-account:billing",
      planChoice: "sales",
      completedAt: new Date("2026-05-24T12:00:00.000Z"),
    });

    expect(recording.calls[0]?.values).toContain(null);
    expect(recording.calls[0]?.values).toContain(null);
    expect(recording.jsonValues[0]).toMatchObject({
      planChoice: "sales",
      status: "completed",
    });
  });
});

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRecordingSql(queryRows?: readonly unknown[]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
  readonly jsonValues: readonly unknown[];
} {
  const calls: RecordedQuery[] = [];
  const jsonValues: unknown[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve(queryRows ?? []);
  };
  return {
    sql: Object.assign(tag, {
      json: (value: unknown) => {
        jsonValues.push(value);
        return value;
      },
    }) as unknown as postgres.Sql,
    calls,
    jsonValues,
  };
}
