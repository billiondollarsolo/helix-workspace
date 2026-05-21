import type { Actor, AuditRecord } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { createToolRegistry, type ToolAuditSink } from "../tool-registry.js";
import {
  AppPasswordManager,
  InMemoryAppPasswordStore,
  registerAppPasswordTools,
} from "./app-passwords.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const otherOrgId = "33333333-3333-4333-8333-333333333333";
const adminActor: Actor = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  orgId,
  type: "user",
  displayName: "User Admin",
  scopes: ["admin.users"],
};

describe("app password tools", () => {
  it("registers create, list, and revoke backend tools", () => {
    const auditSink = new RecordingAuditSink();
    const registry = createToolRegistry({ auditSink });
    registerAppPasswordTools(registry, { store: new InMemoryAppPasswordStore() });

    expect(
      registry
        .list()
        .filter((tool) => tool.id.startsWith("app.passwords."))
        .map((tool) => tool.id),
    ).toEqual(["app.passwords.create", "app.passwords.list", "app.passwords.revoke"]);
  });

  it("creates a scoped one-time app password without exposing a stored hash", async () => {
    const store = new InMemoryAppPasswordStore();
    const auditSink = new RecordingAuditSink();
    const registry = createToolRegistry({ auditSink });
    registerAppPasswordTools(registry, { store });

    const result = await registry.invoke(
      "app.passwords.create",
      {
        actorId,
        label: "Calendar client",
        scopes: ["calendar.read", "calendar.read", "calendar.write"],
        expiresAt: "2026-05-20T18:00:00.000Z",
      },
      {
        actor: adminActor,
        request: { requestId: "req-1", traceId: "trace-1" },
        skipConfirmation: true,
      },
    );

    expect(result.ok).toBe(true);
    const output = result.ok ? (result.output as AppPasswordCreateOutput) : undefined;
    expect(output?.appPassword).toMatchObject({
      actorId,
      orgId,
      label: "Calendar client",
      scopes: ["calendar.read", "calendar.write"],
      expiresAt: "2026-05-20T18:00:00.000Z",
      revokedAt: null,
    });
    expect(output?.appPassword.hash).toBeUndefined();
    expect(output?.password).toMatch(/^helix_ap_/u);
    expect(await store.listAppPasswords({ orgId })).toEqual([
      expect.objectContaining({
        id: output?.appPassword.id,
        actorId,
        scopes: ["calendar.read", "calendar.write"],
      }),
    ]);
    expect(auditSink.records).toHaveLength(1);
    expect(auditSink.records[0]).toMatchObject({
      orgId,
      actorId: adminActor.id,
      verb: "app.password.created",
      objectType: "tool",
      toolId: "app.passwords.create",
      trace: { traceId: "trace-1" },
      metadata: {
        actorType: "user",
        toolPermission: "admin.users",
        credentialType: "app_password",
        targetActorId: actorId,
        targetOrgId: orgId,
        label: "Calendar client",
        scopes: ["calendar.read", "calendar.write"],
      },
    });
  });

  it("rejects unsupported scopes before creating an app password", async () => {
    const store = new InMemoryAppPasswordStore();
    const auditSink = new RecordingAuditSink();
    const registry = createToolRegistry({ auditSink });
    registerAppPasswordTools(registry, { store });

    const result = await registry.invoke(
      "app.passwords.create",
      { actorId, label: "Bad client", scopes: ["calendar.read", "unknown.scope"] },
      { actor: adminActor, skipConfirmation: true },
    );

    expect(result).toMatchObject({
      ok: false,
      statusCode: 400,
    });
    expect(await store.listAppPasswords({ orgId })).toEqual([]);
  });

  it("lists app passwords only in the invoking admin org", async () => {
    const store = new InMemoryAppPasswordStore();
    const manager = new AppPasswordManager(store);
    const active = await manager.create({
      actorId,
      orgId,
      label: "Active",
      scopes: ["caldav"],
      expiresAt: null,
    });
    await manager.create({
      actorId: "44444444-4444-4444-8444-444444444444",
      orgId: otherOrgId,
      label: "Other org",
      scopes: ["caldav"],
      expiresAt: null,
    });
    const revoked = await manager.create({
      actorId,
      orgId,
      label: "Revoked",
      scopes: ["webdav"],
      expiresAt: null,
    });
    await store.revokeAppPassword({
      id: revoked.appPassword.id,
      orgId,
      revokedAt: new Date("2026-05-20T19:00:00.000Z"),
    });
    const auditSink = new RecordingAuditSink();
    const registry = createToolRegistry({ auditSink });
    registerAppPasswordTools(registry, { store });

    const activeOnly = await registry.invoke("app.passwords.list", {}, { actor: adminActor });
    const withRevoked = await registry.invoke(
      "app.passwords.list",
      { includeRevoked: true },
      { actor: adminActor, request: { requestId: "req-list", traceId: "trace-list" } },
    );

    expect(activeOnly.ok ? (activeOnly.output as AppPasswordListOutput).appPasswords : []).toEqual([
      expect.objectContaining({ id: active.appPassword.id, orgId, revokedAt: null }),
    ]);
    const listedWithRevoked = withRevoked.ok
      ? (withRevoked.output as AppPasswordListOutput).appPasswords
      : [];
    expect(listedWithRevoked).toHaveLength(2);
    expect(listedWithRevoked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: revoked.appPassword.id, orgId }),
        expect.objectContaining({ id: active.appPassword.id, orgId, revokedAt: null }),
      ]),
    );
    expect(auditSink.records.map((record) => record.verb)).toEqual([
      "app.password.listed",
      "app.password.listed",
    ]);
    expect(auditSink.records[0]).toMatchObject({
      actorId: adminActor.id,
      toolId: "app.passwords.list",
      metadata: {
        actorType: "user",
        credentialType: "app_password",
        includeRevoked: false,
        resultCount: 1,
      },
    });
    expect(auditSink.records[1]).toMatchObject({
      trace: { traceId: "trace-list" },
      metadata: {
        credentialType: "app_password",
        includeRevoked: true,
        resultCount: 2,
      },
    });
  });

  it("revokes app passwords only inside the invoking admin org", async () => {
    const store = new InMemoryAppPasswordStore();
    const manager = new AppPasswordManager(store);
    const sameOrg = await manager.create({
      actorId,
      orgId,
      label: "Same org",
      scopes: ["caldav"],
      expiresAt: null,
    });
    const otherOrg = await manager.create({
      actorId: "44444444-4444-4444-8444-444444444444",
      orgId: otherOrgId,
      label: "Other org",
      scopes: ["caldav"],
      expiresAt: null,
    });
    const auditSink = new RecordingAuditSink();
    const registry = createToolRegistry({ auditSink });
    registerAppPasswordTools(registry, { store });

    const blocked = await registry.invoke(
      "app.passwords.revoke",
      { passwordId: otherOrg.appPassword.id },
      { actor: adminActor, skipConfirmation: true },
    );
    const revoked = await registry.invoke(
      "app.passwords.revoke",
      { passwordId: sameOrg.appPassword.id },
      { actor: adminActor, skipConfirmation: true },
    );

    expect(blocked.ok ? blocked.output : undefined).toEqual({
      status: "not_found",
      passwordId: otherOrg.appPassword.id,
    });
    expect(revoked.ok ? revoked.output : undefined).toMatchObject({
      status: "revoked",
      appPassword: {
        id: sameOrg.appPassword.id,
        actorId,
        orgId,
      },
    });
    expect(auditSink.records.map((record) => record.verb)).toEqual(["app.password.revoked"]);
    expect(auditSink.records[0]?.metadata).toMatchObject({
      actorType: "user",
      credentialType: "app_password",
      targetActorId: actorId,
      passwordId: sameOrg.appPassword.id,
    });
  });
});

class RecordingAuditSink implements ToolAuditSink {
  readonly records: (AuditRecord & { readonly orgId: string })[] = [];

  async append(record: AuditRecord & { readonly orgId: string }): Promise<void> {
    this.records.push(record);
  }
}

interface AppPasswordCreateOutput {
  readonly appPassword: {
    readonly id: string;
    readonly actorId: string;
    readonly orgId: string;
    readonly hash?: string;
  };
  readonly password: string;
}

interface AppPasswordListOutput {
  readonly appPasswords: readonly {
    readonly id: string;
    readonly orgId: string;
    readonly revokedAt: string | null;
  }[];
}
