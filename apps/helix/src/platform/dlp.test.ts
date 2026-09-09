import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@helix/sdk-types";
import type { SecurityPolicyRecord } from "./admin/security-policies.js";
import { createToolRegistry } from "./tool-registry.js";
import { InMemoryConfirmationGate, InMemoryPendingActionStore } from "./tools/registry.js";
import { TenantDlpGuard, dlpBoundaries, dlpToolInvocation, type DlpAction } from "./dlp.js";

const orgId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";

describe("TenantDlpGuard", () => {
  it("makes the same seeded sensitive-data decision at every egress boundary", async () => {
    const { guard, audit } = fixture("block");

    for (const boundary of dlpBoundaries) {
      await expect(
        guard.evaluate({
          orgId,
          actorId,
          boundary,
          content: "Customer card 4111 1111 1111 1111",
        }),
      ).resolves.toMatchObject({
        action: "block",
        boundary,
        classification: "confidential",
        findings: [{ detector: "credit_card" }],
      });
    }

    expect(audit).toHaveLength(dlpBoundaries.length);
    expect(audit.every((record) => record.verb === "dlp.block")).toBe(true);
    expect(audit.map((record) => record.metadata?.boundary)).toEqual([...dlpBoundaries]);
  });

  it.each(["audit", "warn", "quarantine", "block"] satisfies DlpAction[])(
    "supports the %s policy action",
    async (action) => {
      const { guard } = fixture(action);
      await expect(
        guard.evaluate({
          orgId,
          actorId,
          boundary: "mail_send",
          content: "SSN 123-45-6789",
          acknowledged: true,
        }),
      ).resolves.toMatchObject({ action, acknowledged: true });
    },
  );

  it("uses durable server-derived classifications for identifier-only egress", async () => {
    const { guard } = fixture("quarantine", "restricted");
    await expect(
      guard.evaluate({
        orgId,
        actorId,
        boundary: "copy_export",
        resources: [{ resourceType: "docs.document", resourceId: "doc-1" }],
      }),
    ).resolves.toMatchObject({
      action: "block",
      classification: "restricted",
      findings: [{ detector: "classification", classification: "restricted" }],
    });
  });

  it("fails closed when bounded scanning cannot cover the whole payload", async () => {
    const { guard } = fixture("block");
    await expect(
      guard.evaluate({
        orgId,
        actorId,
        boundary: "drive_upload",
        content: "x".repeat(256 * 1024 + 1),
      }),
    ).resolves.toMatchObject({
      action: "block",
      classification: "restricted",
      findings: [{ detector: "scan_limit" }],
    });
  });

  it("allows clean content and disabled tenant policies without audit noise", async () => {
    const enabled = fixture("block");
    const disabled = fixture("block", null, false);
    await expect(
      enabled.guard.evaluate({ orgId, actorId, boundary: "chat_message", content: "hello" }),
    ).resolves.toMatchObject({ action: "allow", findings: [] });
    await expect(
      disabled.guard.evaluate({
        orgId,
        actorId,
        boundary: "mail_send",
        content: "4111111111111111",
      }),
    ).resolves.toMatchObject({ action: "allow", findings: [] });
    expect(enabled.audit).toHaveLength(0);
    expect(disabled.audit).toHaveLength(0);
  });

  it("enforces confidential label effects even when tenant DLP scanning is disabled", async () => {
    const { guard, audit } = fixture("audit", "confidential", false);
    for (const [boundary, action] of [
      ["drive_share", "audit"],
      ["drive_download", "warn"],
      ["copy_export", "block"],
      ["api_agent", "block"],
      ["external_guest", "block"],
    ] as const) {
      await expect(
        guard.evaluate({
          orgId,
          actorId,
          boundary,
          resources: [{ resourceType: "drive.file", resourceId: "file-1" }],
        }),
      ).resolves.toMatchObject({ action, classification: "confidential" });
    }
    expect(audit).toHaveLength(5);
    expect(audit.every((record) => record.metadata?.sensitivityLabel === true)).toBe(true);
  });
});

describe("dlpToolInvocation", () => {
  const user = { type: "user" as const };

  it.each([
    ["mail.send", { bodyText: "secret" }, "mail_send"],
    ["drive.upload", { name: "secret.txt" }, "drive_upload"],
    ["drive.share", { objectId: "file-1" }, "drive_share"],
    ["drive.link.create", { objectId: "file-1" }, "external_guest"],
    ["chat.send", { body: "secret", attachmentObjectIds: [] }, "chat_message"],
    ["chat.send", { body: "secret", attachmentObjectIds: ["file-1"] }, "chat_attachment"],
    ["docs.copy", { docId: "doc-1" }, "copy_export"],
    ["sheets.export", { sheetId: "sheet-1" }, "copy_export"],
  ] as const)("maps %s to %s enforcement", (toolId, input, expected) => {
    expect(dlpToolInvocation(toolId, input, user)?.boundary).toBe(expected);
  });

  it("canonicalizes every editor export to its backing Drive object", () => {
    expect(dlpToolInvocation("docs.export", { docId: "file-1" }, user)?.resources).toEqual([
      { resourceType: "drive.file", resourceId: "file-1" },
    ]);
    expect(dlpToolInvocation("sheets.copy", { sheetId: "file-2" }, user)?.resources).toEqual([
      { resourceType: "drive.file", resourceId: "file-2" },
    ]);
    expect(dlpToolInvocation("slides.export", { deckId: "file-3" }, user)?.resources).toEqual([
      { resourceType: "drive.file", resourceId: "file-3" },
    ]);
  });

  it("maps service/agent egress through the API/agent boundary", () => {
    expect(
      dlpToolInvocation("mail.send", { bodyText: "secret" }, { type: "agent" })?.boundary,
    ).toBe("api_agent");
  });
});

describe("tool egress enforcement", () => {
  it.each(["block", "quarantine"] as const)("stops %s before persistence", async (action) => {
    let calls = 0;
    const registry = createToolRegistry({
      dlp: {
        evaluate: async () => ({
          action,
          boundary: "mail_send",
          classification: "restricted",
          findings: [{ detector: "credentials", classification: "restricted" }],
          acknowledged: false,
        }),
      },
    });
    registry.register(
      testMailTool(() => {
        calls += 1;
      }),
    );

    const result = await registry.invoke(
      "mail.send",
      { bodyText: "secret" },
      {
        actor: { id: actorId, orgId, type: "user", scopes: ["mail.send"] },
      },
    );

    expect(result).toMatchObject({ ok: false, statusCode: action === "block" ? 403 : 423 });
    expect(calls).toBe(0);
  });

  it("uses the existing confirmation gate for warn, then executes acknowledged content", async () => {
    let calls = 0;
    const confirmationGate = new InMemoryConfirmationGate(new InMemoryPendingActionStore());
    const registry = createToolRegistry({
      confirmationGate,
      resolvePendingPrincipal: async () => ({
        actor: { id: actorId, orgId, type: "user", scopes: ["mail.send"] },
      }),
      dlp: {
        evaluate: async (input) => ({
          action: "warn",
          boundary: input.boundary,
          classification: "confidential",
          findings: [{ detector: "pii", classification: "confidential" }],
          acknowledged: input.acknowledged === true,
        }),
      },
    });
    registry.register(
      testMailTool(() => {
        calls += 1;
      }),
    );
    const actor = { id: actorId, orgId, type: "user" as const, scopes: ["mail.send"] };

    const pending = await registry.invoke("mail.send", { bodyText: "123-45-6789" }, { actor });
    expect(pending).toMatchObject({ ok: true, status: "pending_confirmation" });
    expect(calls).toBe(0);
    if (!pending.ok || pending.status !== "pending_confirmation")
      throw new Error("expected pending");
    await expect(registry.approvePending(pending.pending.id, { actor })).resolves.toMatchObject({
      ok: true,
      output: { sent: true },
    });
    expect(calls).toBe(1);
  });

  it("scans export and agent output before it leaves the API", async () => {
    const { guard } = fixture("block");
    const registry = createToolRegistry({ dlp: guard });
    registry.register({
      id: "chat.export",
      description: "test export",
      permission: "chat.read",
      sideEffects: "read",
      inputSchema: { parse: (value) => value, toJsonSchema: () => ({ type: "object" }) },
      outputSchema: { parse: (value) => value, toJsonSchema: () => ({ type: "object" }) },
      handler: async () => ({ messages: [{ body: "4111 1111 1111 1111" }] }),
    });

    await expect(
      registry.invoke(
        "chat.export",
        { roomId: "room-1" },
        {
          actor: { id: actorId, orgId, type: "user", scopes: ["chat.read"] },
        },
      ),
    ).resolves.toMatchObject({ ok: false, statusCode: 403 });
  });
});

function fixture(
  action: Exclude<DlpAction, "allow">,
  storedClassification: "confidential" | "restricted" | null = null,
  enabled = true,
) {
  const audit: Array<{ verb: string; metadata?: Record<string, unknown> }> = [];
  const policy: SecurityPolicyRecord = {
    id: "policy-1",
    orgId,
    policyType: "dlp",
    enabled,
    enforcement: "required",
    settings: {
      action,
      detectors: ["pii", "credentials", "credit_card", "source_code"],
      boundaries: [...dlpBoundaries],
    },
    updatedBy: actorId,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
  return {
    audit,
    guard: new TenantDlpGuard(
      { get: async () => policy },
      {
        get: async (resource) =>
          storedClassification === null
            ? null
            : {
                ...resource,
                classification: storedClassification,
                source: "heuristic",
                reason: "seed",
                updatedAt: "2026-09-03T00:00:00.000Z",
              },
        classify: async (resource) => ({
          derivation: {
            classification: resource.derivation.explicit ?? "standard",
            source: "explicit",
            reason: "explicit classification",
          },
          record: {
            orgId: resource.orgId,
            resourceType: resource.resourceType,
            resourceId: resource.resourceId,
            classification: resource.derivation.explicit ?? "standard",
            source: "explicit",
            reason: "explicit classification",
            updatedAt: "2026-09-03T00:00:00.000Z",
          },
        }),
      },
      {
        append: async (record) => {
          audit.push({
            verb: record.verb,
            ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
          });
        },
      },
    ),
  };
}

function testMailTool(onCall: () => void): ToolDefinition {
  return {
    id: "mail.send",
    description: "test mail",
    permission: "mail.send",
    sideEffects: "external_communication",
    inputSchema: { parse: (value) => value, toJsonSchema: () => ({ type: "object" }) },
    outputSchema: { parse: (value) => value, toJsonSchema: () => ({ type: "object" }) },
    handler: async () => {
      onCall();
      return { sent: true };
    },
  };
}
