import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  initialOwnerActorScopes,
  initialOwnerActorStepName,
  PostgresTenantOwnerActorStore,
} from "./provisioning-owner.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";

describe("PostgresTenantOwnerActorStore", () => {
  it("creates a normalized initial owner actor for tenant provisioning", async () => {
    const recording = createRecordingSql();
    const store = new PostgresTenantOwnerActorStore(recording.sql);

    const actor = await store.ensureInitialOwnerActor({
      orgId,
      email: " Owner@Example.COM ",
      metadata: { source: "signup" },
    });

    expect(actor).toMatchObject({
      id: actorId,
      orgId,
      type: "user",
      email: "owner@example.com",
      displayName: "owner@example.com",
      scopes: ["admin.*"],
      metadata: {
        source: "signup",
        tenantProvisioning: { role: "owner", source: "signup" },
      },
    });
    expect(initialOwnerActorStepName).toBe("initial_owner_actor_created");
    expect(initialOwnerActorScopes).toEqual(["admin.*"]);
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).toContain("insert into actors");
    expect(recording.calls[0]?.text).toContain("on conflict (org_id, email) do update");
    expect(recording.calls[0]?.text).toContain("'admin.*' = any(actors.scopes)");
    expect(recording.calls[0]?.text).not.toContain('insert into "user"');
    expect(recording.calls[0]?.text).not.toContain("insert into session");
    expect(recording.calls[0]?.text).not.toContain("insert into account");
    expect(recording.calls[0]?.values).toContain(orgId);
    expect(recording.calls[0]?.values).toContain("owner@example.com");
  });

  it("uses an explicit display name when supplied", async () => {
    const recording = createRecordingSql();
    const store = new PostgresTenantOwnerActorStore(recording.sql);

    await store.ensureInitialOwnerActor({
      orgId,
      email: "owner@example.com",
      displayName: "  Owner Name  ",
    });

    expect(recording.calls[0]?.values).toContain("Owner Name");
  });
});

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRecordingSql(): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve([
      {
        id: actorId,
        org_id: orgId,
        type: "user",
        email: "owner@example.com",
        display_name: values.find((value) => value === "Owner Name") ?? "owner@example.com",
        scopes: ["admin.*"],
        metadata: {
          source: "signup",
          tenantProvisioning: { role: "owner", source: "signup" },
        },
      },
    ]);
  };
  return {
    sql: Object.assign(tag, {
      array: (value: unknown) => value,
      json: (value: unknown) => value,
    }) as unknown as postgres.Sql,
    calls,
  };
}
