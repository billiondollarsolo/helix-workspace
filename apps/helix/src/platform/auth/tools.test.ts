import type { AuditRecord, Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { createToolRegistry, type ToolAuditSink } from "../tool-registry.js";
import { InMemoryOAuthClientStore, hashSecret } from "./oauth.js";
import { registerAgentCredentialTools } from "./tools.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const agentActorId = "11111111-1111-4111-8111-111111111111";
const otherOrgId = "33333333-3333-4333-8333-333333333333";
const adminActor: Actor = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  orgId,
  type: "user",
  displayName: "Agent Admin",
  scopes: ["admin.agents"],
};

describe("agent credential tools", () => {
  it("registers create, list, and revoke backend tools", () => {
    const registry = createToolRegistry();
    registerAgentCredentialTools(registry, { clientStore: new InMemoryOAuthClientStore() });

    expect(
      registry
        .list()
        .filter((tool) => tool.id.startsWith("agent.credentials."))
        .map((tool) => tool.id),
    ).toEqual(["agent.credentials.create", "agent.credentials.list", "agent.credentials.revoke"]);
  });

  it("creates a scoped OAuth client without exposing the stored secret hash and records admin audit", async () => {
    const store = new InMemoryOAuthClientStore();
    const auditSink = new RecordingAuditSink();
    const registry = createToolRegistry({ auditSink });
    registerAgentCredentialTools(registry, { clientStore: store });

    const result = await registry.invoke(
      "agent.credentials.create",
      {
        actorId: agentActorId,
        scopes: ["mail.read", "mail.read", "drive.write"],
        expiresAt: "2026-05-20T18:00:00.000Z",
      },
      {
        actor: adminActor,
        request: { requestId: "req-1", traceId: "trace-1" },
        skipConfirmation: true,
      },
    );

    expect(result.ok).toBe(true);
    const output = result.ok ? (result.output as AgentCredentialCreateOutput) : undefined;
    expect(output?.credential).toMatchObject({
      actorId: agentActorId,
      orgId,
      scopes: ["mail.read", "drive.write"],
      expiresAt: "2026-05-20T18:00:00.000Z",
      revokedAt: null,
    });
    expect(output?.credential.clientSecretHash).toBeUndefined();
    expect(output?.clientSecret).toMatch(/^helix_cs_/u);
    expect(await store.findClient(output?.credential.clientId ?? "")).toMatchObject({
      actorId: agentActorId,
      orgId,
      scopes: ["mail.read", "drive.write"],
    });
    expect(auditSink.domainRecords).toHaveLength(1);
    expect(auditSink.domainRecords[0]).toMatchObject({
      orgId,
      actorId: adminActor.id,
      verb: "agent.credential.created",
      objectType: "tool",
      toolId: "agent.credentials.create",
      trace: { traceId: "trace-1" },
      metadata: {
        actorType: "user",
        toolPermission: "admin.agents",
        credentialType: "oauth_client",
        targetActorId: agentActorId,
        targetOrgId: orgId,
        scopes: ["mail.read", "drive.write"],
      },
    });
  });

  it("rejects unsupported scopes before creating a credential", async () => {
    const store = new InMemoryOAuthClientStore();
    const registry = createToolRegistry();
    registerAgentCredentialTools(registry, { clientStore: store });

    const result = await registry.invoke(
      "agent.credentials.create",
      { actorId: agentActorId, scopes: ["mail.read", "unknown.scope"] },
      { actor: adminActor, skipConfirmation: true },
    );

    expect(result).toMatchObject({
      ok: false,
      statusCode: 400,
    });
    expect(await store.listClients({ orgId })).toEqual([]);
  });

  it("lists only credentials in the invoking admin org and can include revoked credentials", async () => {
    const store = new InMemoryOAuthClientStore();
    await store.createClient({
      clientId: "client-active",
      clientSecretHash: await hashSecret("secret-active"),
      actorId: agentActorId,
      orgId,
      scopes: ["mail.read"],
    });
    await store.createClient({
      clientId: "client-other-org",
      clientSecretHash: await hashSecret("secret-other"),
      actorId: "44444444-4444-4444-8444-444444444444",
      orgId: otherOrgId,
      scopes: ["mail.read"],
    });
    await store.createClient({
      clientId: "client-revoked",
      clientSecretHash: await hashSecret("secret-revoked"),
      actorId: agentActorId,
      orgId,
      scopes: ["drive.read"],
    });
    await store.revokeClient("client-revoked", new Date("2026-05-20T19:00:00.000Z"));
    const auditSink = new RecordingAuditSink();
    const registry = createToolRegistry({ auditSink });
    registerAgentCredentialTools(registry, { clientStore: store });

    const activeOnly = await registry.invoke("agent.credentials.list", {}, { actor: adminActor });
    const withRevoked = await registry.invoke(
      "agent.credentials.list",
      { includeRevoked: true },
      { actor: adminActor, request: { requestId: "req-list", traceId: "trace-list" } },
    );

    expect(
      activeOnly.ok ? (activeOnly.output as AgentCredentialListOutput).credentials : [],
    ).toEqual([expect.objectContaining({ clientId: "client-active", orgId, revokedAt: null })]);
    expect(
      withRevoked.ok ? (withRevoked.output as AgentCredentialListOutput).credentials : [],
    ).toEqual([
      expect.objectContaining({ clientId: "client-active", orgId, revokedAt: null }),
      expect.objectContaining({
        clientId: "client-revoked",
        orgId,
        revokedAt: "2026-05-20T19:00:00.000Z",
      }),
    ]);
    expect(auditSink.domainRecords.map((record) => record.verb)).toEqual([
      "agent.credential.listed",
      "agent.credential.listed",
    ]);
    expect(auditSink.domainRecords[0]).toMatchObject({
      actorId: adminActor.id,
      toolId: "agent.credentials.list",
      metadata: {
        actorType: "user",
        credentialType: "oauth_client",
        includeRevoked: false,
        resultCount: 1,
      },
    });
    expect(auditSink.domainRecords[1]).toMatchObject({
      trace: { traceId: "trace-list" },
      metadata: {
        credentialType: "oauth_client",
        includeRevoked: true,
        resultCount: 2,
      },
    });
  });

  it("revokes credentials only inside the invoking admin org and records destructive audit", async () => {
    const store = new InMemoryOAuthClientStore();
    await store.createClient({
      clientId: "client-same-org",
      clientSecretHash: await hashSecret("secret-same"),
      actorId: agentActorId,
      orgId,
      scopes: ["mail.read"],
    });
    await store.createClient({
      clientId: "client-other-org",
      clientSecretHash: await hashSecret("secret-other"),
      actorId: "44444444-4444-4444-8444-444444444444",
      orgId: otherOrgId,
      scopes: ["mail.read"],
    });
    const auditSink = new RecordingAuditSink();
    const registry = createToolRegistry({ auditSink });
    registerAgentCredentialTools(registry, { clientStore: store });

    const blocked = await registry.invoke(
      "agent.credentials.revoke",
      { clientId: "client-other-org" },
      { actor: adminActor, skipConfirmation: true },
    );
    const revoked = await registry.invoke(
      "agent.credentials.revoke",
      { clientId: "client-same-org" },
      { actor: adminActor, skipConfirmation: true },
    );

    expect(blocked.ok ? blocked.output : undefined).toEqual({
      status: "not_found",
      clientId: "client-other-org",
    });
    expect(await store.findClient("client-other-org")).toMatchObject({ revokedAt: null });
    expect(revoked.ok ? revoked.output : undefined).toMatchObject({
      status: "revoked",
      credential: {
        clientId: "client-same-org",
        actorId: agentActorId,
        orgId,
      },
    });
    const revokedClient = await store.findClient("client-same-org");
    expect(revokedClient?.revokedAt).toBeInstanceOf(Date);
    expect(auditSink.domainRecords.map((record) => record.verb)).toEqual([
      "agent.credential.revoked",
    ]);
    expect(auditSink.domainRecords[0]?.metadata).toMatchObject({
      actorType: "user",
      credentialType: "oauth_client",
      targetActorId: agentActorId,
      clientId: "client-same-org",
    });
  });
});

class RecordingAuditSink implements ToolAuditSink {
  readonly records: (AuditRecord & { readonly orgId: string })[] = [];

  get domainRecords(): readonly (AuditRecord & { readonly orgId: string })[] {
    return this.records.filter((record) => !record.verb.startsWith("tool.invocation."));
  }

  async append(record: AuditRecord & { readonly orgId: string }): Promise<void> {
    this.records.push(record);
  }
}

interface AgentCredentialCreateOutput {
  readonly credential: {
    readonly clientId: string;
    readonly clientSecretHash?: string;
  };
  readonly clientSecret: string;
}

interface AgentCredentialListOutput {
  readonly credentials: readonly {
    readonly clientId: string;
    readonly orgId: string;
    readonly revokedAt: string | null;
  }[];
}
