import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  ClassificationGateError,
  InMemoryResourceClassificationStore,
  PostgresResourceClassificationStore,
  ResourceClassificationService,
  deriveClassification,
  enforceClassificationGate,
  evaluateClassificationGate,
  isAIProviderClassificationTag,
  normalizeProviderTags,
} from "./index.js";

describe("classification policy", () => {
  it("derives the most restrictive classification from explicit labels folders and heuristics", () => {
    expect(
      deriveClassification({
        explicit: "public",
        labels: ["Confidential"],
        path: "/Projects/Public/Launch",
      }),
    ).toMatchObject({
      classification: "confidential",
      source: "label",
    });

    expect(
      deriveClassification({
        labels: ["public"],
        path: "/HR/Restricted/Offer",
        content: "safe content",
      }),
    ).toMatchObject({
      classification: "restricted",
      source: "folder",
    });

    expect(
      deriveClassification({
        content: "employee ssn is 111-22-3333",
        scanContent: true,
      }),
    ).toMatchObject({
      classification: "confidential",
      source: "heuristic",
    });
  });
});

describe("classification gate", () => {
  it("allows personal tier providers when classification gating is off by default", () => {
    expect(
      evaluateClassificationGate({
        classification: "restricted",
        provider: { providerId: "openai", tags: ["external"] },
        tier: "personal",
      }),
    ).toMatchObject({
      allowed: true,
      reason: "classification_gating_disabled",
    });
  });

  it("requires stronger provider tags as classification increases", () => {
    expect(
      evaluateClassificationGate({
        classification: "standard",
        provider: { providerId: "openai", tags: ["external", "admin-allowlisted"] },
        tier: "business",
      }),
    ).toMatchObject({ allowed: true });

    expect(
      evaluateClassificationGate({
        classification: "confidential",
        provider: { providerId: "openai", tags: ["external", "admin-allowlisted"] },
        tier: "business",
      }),
    ).toMatchObject({
      allowed: false,
      reason: "provider_missing_confidential_tag",
    });

    expect(
      evaluateClassificationGate({
        classification: "restricted",
        provider: { providerId: "ollama", tags: ["local-only"] },
        tier: "enterprise",
      }),
    ).toMatchObject({
      allowed: true,
      reason: "provider_allowed_for_restricted",
    });
  });

  it("throws an audit-friendly decision when enforced", () => {
    expect(() =>
      enforceClassificationGate({
        classification: "restricted",
        provider: { providerId: "cloud", tags: ["admin-allowlisted"] },
        tier: "business",
      }),
    ).toThrow(ClassificationGateError);
  });
});

describe("resource classification store", () => {
  it("stores resource classification tags by org resource type and resource id", async () => {
    const store = new InMemoryResourceClassificationStore();
    await store.set({
      orgId: "org-1",
      resourceType: "mail.message",
      resourceId: "msg-1",
      classification: "confidential",
      source: "label",
      reason: "label:Confidential",
      updatedAt: "2026-05-20T00:00:00.000Z",
    });

    expect(
      await store.get({
        orgId: "org-1",
        resourceType: "mail.message",
        resourceId: "msg-1",
      }),
    ).toMatchObject({
      classification: "confidential",
      reason: "label:Confidential",
    });
  });
});

describe("shared provider tag vocabulary", () => {
  it("recognizes and normalizes only known classification tags", () => {
    expect(isAIProviderClassificationTag("local-only")).toBe(true);
    expect(isAIProviderClassificationTag("not-a-tag")).toBe(false);
    expect(normalizeProviderTags(["local-only", "bogus", "baa-dpa"])).toEqual([
      "local-only",
      "baa-dpa",
    ]);
  });
});

describe("ResourceClassificationService", () => {
  it("derives, persists, and reads back the §8.4 classification", async () => {
    const store = new InMemoryResourceClassificationStore();
    const service = new ResourceClassificationService(store, {
      now: () => new Date("2026-05-21T00:00:00.000Z"),
    });

    const { derivation, record } = await service.classify({
      orgId: "org-1",
      resourceType: "mail.message",
      resourceId: "msg-9",
      derivation: { labels: ["HR"] },
      actorId: "00000000-0000-0000-0000-0000000000aa",
    });

    expect(derivation).toMatchObject({ classification: "confidential", source: "label" });
    expect(record).toMatchObject({
      orgId: "org-1",
      resourceType: "mail.message",
      resourceId: "msg-9",
      classification: "confidential",
      updatedAt: "2026-05-21T00:00:00.000Z",
    });

    expect(
      await service.get({ orgId: "org-1", resourceType: "mail.message", resourceId: "msg-9" }),
    ).toMatchObject({ classification: "confidential" });
  });

  it("detects PII heuristically and folder-derived classifications", async () => {
    const store = new InMemoryResourceClassificationStore();
    const service = new ResourceClassificationService(store);

    const heuristic = await service.classify({
      orgId: "org-1",
      resourceType: "docs.document",
      resourceId: "doc-1",
      derivation: { content: "ssn 123-45-6789", scanContent: true },
    });
    expect(heuristic.derivation).toMatchObject({ classification: "confidential", source: "heuristic" });

    const folder = await service.classify({
      orgId: "org-1",
      resourceType: "drive.file",
      resourceId: "file-1",
      derivation: { path: "/Restricted/plan.pdf" },
    });
    expect(folder.derivation).toMatchObject({ classification: "restricted", source: "folder" });
  });

  it("resolve returns the stored classification without re-deriving", async () => {
    const store = new InMemoryResourceClassificationStore();
    const service = new ResourceClassificationService(store);
    await store.set({
      orgId: "org-1",
      resourceType: "mail.message",
      resourceId: "msg-stored",
      classification: "restricted",
      source: "explicit",
      reason: "explicit classification",
      updatedAt: "2026-05-21T00:00:00.000Z",
    });

    const resolved = await service.resolve({
      orgId: "org-1",
      resourceType: "mail.message",
      resourceId: "msg-stored",
      derivation: { labels: ["public"] },
    });
    expect(resolved.classification).toBe("restricted");
  });
});

describe("PostgresResourceClassificationStore", () => {
  it("upserts and reads classification rows", async () => {
    const recording = createRecordingSql([
      [],
      [
        {
          org_id: "org-1",
          resource_type: "mail.message",
          resource_id: "msg-1",
          classification: "confidential",
          source: "label",
          reason: "label:HR",
          actor_id: null,
          updated_at: new Date("2026-05-21T00:00:00.000Z"),
        },
      ],
    ]);
    const store = new PostgresResourceClassificationStore(recording.sql);

    await store.set({
      orgId: "org-1",
      resourceType: "mail.message",
      resourceId: "msg-1",
      classification: "confidential",
      source: "label",
      reason: "label:HR",
      updatedAt: "2026-05-21T00:00:00.000Z",
    });
    expect(recording.calls[0]?.text).toContain("insert into resource_classifications");
    expect(recording.calls[0]?.text).toContain("on conflict");

    const record = await store.get({
      orgId: "org-1",
      resourceType: "mail.message",
      resourceId: "msg-1",
    });
    expect(record).toMatchObject({ classification: "confidential", reason: "label:HR" });
    expect(recording.calls[1]?.text).toContain("from resource_classifications");
  });
});

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRecordingSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  const queue = [...responses];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$"), values });
    return Promise.resolve(queue.shift() ?? []);
  };
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
  }) as unknown as postgres.Sql;
  return { sql, calls };
}
