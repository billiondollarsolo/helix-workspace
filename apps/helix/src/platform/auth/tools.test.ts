import type { Actor, AuditRecord } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { createToolRegistry, type ToolAuditSink } from "../tool-registry.js";
import {
  EMPTY_CREDENTIAL_POLICY,
  type AgentCredentialInventoryRecord,
  type AgentCredentialLifecycleStore,
  type IssueAgentCredentialInput,
  type RotateAgentCredentialInput,
} from "./credentials.js";
import { registerAgentCredentialTools } from "./tools.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const serviceId = "33333333-3333-4333-8333-333333333333";
const admin: Actor = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  orgId,
  type: "user",
  displayName: "Credential Owner",
  scopes: ["admin.agents", "mail.read", "drive.write"],
};
const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();

describe("non-human credential tools", () => {
  it("registers one lifecycle for issuance, inventory, rotation, and revocation", () => {
    const registry = createToolRegistry();
    registerAgentCredentialTools(registry, { store: new MemoryCredentialStore() });
    expect(
      registry
        .list()
        .filter((tool) => tool.id.startsWith("agent.credentials."))
        .map((tool) => tool.id),
    ).toEqual([
      "agent.credentials.create",
      "agent.credentials.list",
      "agent.credentials.revoke",
      "agent.credentials.rotate",
    ]);
  });

  it("issues distinct OAuth, API-key, and certificate material with accountable inventory", async () => {
    const store = new MemoryCredentialStore();
    const registry = createToolRegistry();
    registerAgentCredentialTools(registry, { store });

    const oauth = await invokeCreate(registry, {
      actorId: agentId,
      credentialType: "oauth_client",
      label: "Mail bot OAuth",
      purpose: "Process support mail",
      scopes: ["mail.read"],
    });
    const apiKey = await invokeCreate(registry, {
      actorId: serviceId,
      credentialType: "api_key",
      label: "Drive importer",
      purpose: "Import customer files",
      scopes: ["drive.write"],
    });
    const certificate = await invokeCreate(registry, {
      actorId: serviceId,
      credentialType: "mtls_cert",
      label: "Warehouse certificate",
      purpose: "Mutual TLS ingestion",
      scopes: ["mail.read"],
      certificateFingerprint: `sha256:${"A".repeat(64)}`,
    });

    expect(oauth.secret).toMatch(/^helix_cs_/u);
    expect(oauth.credential).toMatchObject({
      principalType: "agent",
      ownerActorId: admin.id,
      purpose: "Process support mail",
    });
    expect(apiKey.secret).toMatch(/^helix_ak_/u);
    expect(apiKey.credential).toMatchObject({ principalType: "service_account" });
    expect(certificate.secret).toBeUndefined();
    expect(certificate.credential).toMatchObject({
      credentialType: "mtls_cert",
      certFingerprint: "a".repeat(64),
    });
    expect(await store.list({ orgId, includeRevoked: false })).toHaveLength(3);
  });

  it("rejects unknown, excessive, and expired grants before persistence", async () => {
    const store = new MemoryCredentialStore();
    const registry = createToolRegistry();
    registerAgentCredentialTools(registry, { store });

    const unknown = await registry.invoke(
      "agent.credentials.create",
      createInput({ scopes: ["unknown.scope"] }),
      { actor: admin, skipConfirmation: true },
    );
    const excessive = await registry.invoke(
      "agent.credentials.create",
      createInput({ scopes: ["admin.audit"] }),
      { actor: admin, skipConfirmation: true },
    );
    const expired = await registry.invoke(
      "agent.credentials.create",
      createInput({ expiresAt: "2020-01-01T00:00:00.000Z" }),
      { actor: admin, skipConfirmation: true },
    );

    expect(unknown).toMatchObject({ ok: false, statusCode: 400 });
    expect(excessive).toMatchObject({ ok: false, statusCode: 400 });
    expect(expired).toMatchObject({ ok: false, statusCode: 400 });
    expect(await store.list({ orgId, includeRevoked: true })).toEqual([]);
  });

  it("rotates one-time key material, preserves inventory, and revokes immediately", async () => {
    const store = new MemoryCredentialStore();
    const registry = createToolRegistry();
    registerAgentCredentialTools(registry, { store });
    const issued = await invokeCreate(registry, {
      actorId: serviceId,
      credentialType: "api_key",
      label: "Importer",
      purpose: "Nightly import",
      scopes: ["drive.write"],
    });
    const credentialId = issued.credential.id as string;

    const rotated = await registry.invoke(
      "agent.credentials.rotate",
      { credentialId, expiresAt },
      { actor: admin, skipConfirmation: true },
    );
    const rotation = rotated.ok ? (rotated.output as CredentialOutput) : undefined;
    expect(rotation?.status).toBe("rotated");
    expect(rotation?.secret).toMatch(/^helix_ak_/u);
    expect(rotation?.secret).not.toBe(issued.secret);

    const revoked = await registry.invoke(
      "agent.credentials.revoke",
      { credentialId },
      { actor: admin, skipConfirmation: true },
    );
    expect(revoked.ok ? revoked.output : undefined).toMatchObject({
      status: "revoked",
      credential: { id: credentialId },
    });
    expect(await store.list({ orgId, includeRevoked: false })).toEqual([]);
    expect(await store.list({ orgId, includeRevoked: true })).toHaveLength(1);
  });

  it("audits inventory access without exposing credential material", async () => {
    const audit = new RecordingAuditSink();
    const registry = createToolRegistry({ auditSink: audit });
    registerAgentCredentialTools(registry, { store: new MemoryCredentialStore() });
    await registry.invoke(
      "agent.credentials.list",
      {},
      { actor: admin, request: { requestId: "req", traceId: "trace" } },
    );
    expect(audit.records[0]).toMatchObject({
      verb: "nonhuman.credential.inventory.viewed",
      metadata: { resultCount: 0, includeRevoked: false },
      trace: { traceId: "trace" },
    });
  });
});

function createInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actorId: agentId,
    credentialType: "oauth_client",
    label: "Mail bot",
    purpose: "Process mail",
    scopes: ["mail.read"],
    expiresAt,
    ...overrides,
  };
}

async function invokeCreate(
  registry: ReturnType<typeof createToolRegistry>,
  input: Record<string, unknown>,
): Promise<CredentialOutput> {
  const result = await registry.invoke(
    "agent.credentials.create",
    { ...input, expiresAt },
    { actor: admin, skipConfirmation: true },
  );
  expect(result.ok).toBe(true);
  return (result as { readonly output: CredentialOutput }).output;
}

interface CredentialOutput {
  readonly status?: string;
  readonly secret?: string;
  readonly credential: Record<string, unknown>;
}

class MemoryCredentialStore implements AgentCredentialLifecycleStore {
  readonly #records = new Map<string, AgentCredentialInventoryRecord>();

  async issue(input: IssueAgentCredentialInput): Promise<AgentCredentialInventoryRecord> {
    const id = `00000000-0000-4000-8000-${String(this.#records.size + 1).padStart(12, "0")}`;
    const record: AgentCredentialInventoryRecord = {
      id,
      credentialType: input.credentialType,
      principalType: input.principalActorId === agentId ? "agent" : "service_account",
      actorId: input.principalActorId,
      orgId: input.orgId,
      ownerActorId: input.operatorActorId,
      scopes: [...input.scopes],
      clientId: input.clientId ?? null,
      secretHash: input.secretHash ?? null,
      apiKeyHash: input.apiKeyHash ?? null,
      certFingerprint: input.certFingerprint ?? null,
      label: input.label,
      purpose: input.purpose,
      policy: EMPTY_CREDENTIAL_POLICY,
      expiresAt: input.expiresAt,
      revokedAt: null,
      createdAt: new Date(),
      rotatedAt: null,
      lastUsedAt: null,
    };
    this.#records.set(id, record);
    return record;
  }

  async list(input: {
    readonly orgId: string;
    readonly principalActorId?: string;
    readonly includeRevoked: boolean;
  }): Promise<readonly AgentCredentialInventoryRecord[]> {
    return [...this.#records.values()].filter(
      (record) =>
        record.orgId === input.orgId &&
        (input.principalActorId === undefined || record.actorId === input.principalActorId) &&
        (input.includeRevoked || record.revokedAt === null),
    );
  }

  async rotate(input: RotateAgentCredentialInput): Promise<AgentCredentialInventoryRecord | null> {
    const record = this.#owned(input.orgId, input.operatorActorId, input.credentialId);
    if (record === null) return null;
    const rotated = {
      ...record,
      secretHash: input.secretHash ?? null,
      apiKeyHash: input.apiKeyHash ?? null,
      certFingerprint: input.certFingerprint ?? null,
      expiresAt: input.expiresAt,
      rotatedAt: new Date(),
    };
    this.#records.set(record.id, rotated);
    return rotated;
  }

  async revoke(input: {
    readonly orgId: string;
    readonly operatorActorId: string;
    readonly credentialId: string;
  }): Promise<AgentCredentialInventoryRecord | null> {
    const record = this.#owned(input.orgId, input.operatorActorId, input.credentialId);
    if (record === null) return null;
    const revoked = { ...record, revokedAt: new Date() };
    this.#records.set(record.id, revoked);
    return revoked;
  }

  async findByApiKeyHash(apiKeyHash: string): Promise<AgentCredentialInventoryRecord | null> {
    return [...this.#records.values()].find((record) => record.apiKeyHash === apiKeyHash) ?? null;
  }

  async findByCertFingerprint(fingerprint: string): Promise<AgentCredentialInventoryRecord | null> {
    return (
      [...this.#records.values()].find((record) => record.certFingerprint === fingerprint) ?? null
    );
  }

  #owned(org: string, owner: string, id: string): AgentCredentialInventoryRecord | null {
    const record = this.#records.get(id);
    return record?.orgId === org && record.ownerActorId === owner && record.revokedAt === null
      ? record
      : null;
  }
}

class RecordingAuditSink implements ToolAuditSink {
  readonly records: (AuditRecord & { readonly orgId: string })[] = [];

  async append(record: AuditRecord & { readonly orgId: string }): Promise<void> {
    this.records.push(record);
  }
}
