import { describe, expect, it } from "vitest";
import type { AICallContext, AICapability, ChatRequest, ChatResponse } from "@helix/sdk-types";
import type {
  DriveActivityPayload,
  DriveAutoTagWrite,
  DriveEnrichmentProjectionStore,
  DriveEnrichmentRecord,
  DriveEnrichmentWrite,
} from "../types.js";
import type { EnrichmentEvent } from "../../ai/enrichment/index.js";
import { createDriveAutoTagEnrichmentHandler } from "./enrichments.js";

const baseFile: DriveEnrichmentRecord = {
  id: "file-1",
  orgId: "org-1",
  kind: "file",
  name: "quarterly-report.pdf",
  mimeType: "application/pdf",
  byteSize: 1024,
  path: ["My Drive", "Finance", "quarterly-report.pdf"],
  classification: "standard",
  createdAt: "2026-05-20T00:00:00.000Z",
};

class FakeDriveEnrichmentStore implements DriveEnrichmentProjectionStore {
  readonly enrichments: DriveEnrichmentWrite[] = [];
  readonly autoTags: DriveAutoTagWrite[] = [];

  constructor(private readonly file: DriveEnrichmentRecord | null) {}

  async getDriveEnrichmentRecord(): Promise<DriveEnrichmentRecord | null> {
    return this.file;
  }

  async recordDriveEnrichment(input: DriveEnrichmentWrite): Promise<void> {
    this.enrichments.push(input);
  }

  async setDriveAutoTags(input: DriveAutoTagWrite): Promise<void> {
    this.autoTags.push(input);
  }
}

class FakeAI implements AICapability {
  readonly calls: ChatRequest[] = [];

  constructor(private readonly tags: readonly string[]) {}

  async chat(request: ChatRequest, _ctx?: Partial<AICallContext>): Promise<ChatResponse> {
    void _ctx;
    this.calls.push(request);
    return {
      message: JSON.stringify({ tags: this.tags }),
      model: "fake-model",
      providerId: "fake-ai",
    };
  }
}

function uploadEvent(objectId = "file-1"): EnrichmentEvent<DriveActivityPayload> {
  return {
    subject: "activity.drive.upload.finalized",
    payload: { objectId },
    occurredAt: "2026-05-20T00:00:00.000Z",
  };
}

describe("drive.auto-tag enrichment", () => {
  it("derives heuristic tags without an AI capability", async () => {
    const store = new FakeDriveEnrichmentStore(baseFile);
    const handler = createDriveAutoTagEnrichmentHandler({ store });

    const result = await handler.enrich(uploadEvent());

    expect(result?.status).toBe("applied");
    expect(store.autoTags).toHaveLength(1);
    expect(store.autoTags[0]?.source).toBe("heuristic");
    expect(store.autoTags[0]?.tags).toEqual(expect.arrayContaining(["pdf", "finance"]));
    expect(store.enrichments[0]?.feature).toBe("drive.auto-tag");
  });

  it("merges AI-suggested tags with heuristics and existing tags", async () => {
    const store = new FakeDriveEnrichmentStore({ ...baseFile, tags: ["legacy"] });
    const ai = new FakeAI(["Revenue", "Forecast", "revenue"]);
    const handler = createDriveAutoTagEnrichmentHandler({ store, ai });

    const result = await handler.enrich(uploadEvent());

    expect(result?.status).toBe("applied");
    expect(ai.calls[0]?.feature).toBe("drive.auto-tag");
    const tags = store.autoTags[0]?.tags ?? [];
    expect(store.autoTags[0]?.source).toBe("ai");
    expect(tags).toEqual(expect.arrayContaining(["legacy", "pdf", "revenue", "forecast"]));
    // lowercased + de-duplicated
    expect(tags.filter((tag) => tag === "revenue")).toHaveLength(1);
  });

  it("respects the maxTags cap", async () => {
    const store = new FakeDriveEnrichmentStore(baseFile);
    const ai = new FakeAI(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const handler = createDriveAutoTagEnrichmentHandler({ store, ai, maxTags: 3 });

    await handler.enrich(uploadEvent());

    expect(store.autoTags[0]?.tags).toHaveLength(3);
  });

  it("skips when the file is missing", async () => {
    const store = new FakeDriveEnrichmentStore(null);
    const handler = createDriveAutoTagEnrichmentHandler({ store });

    const result = await handler.enrich(uploadEvent("missing"));

    expect(result?.status).toBe("skipped");
    expect(store.autoTags).toHaveLength(0);
  });

  it("skips deleted files", async () => {
    const store = new FakeDriveEnrichmentStore({
      ...baseFile,
      deletedAt: "2026-05-20T01:00:00.000Z",
    });
    const handler = createDriveAutoTagEnrichmentHandler({ store });

    const result = await handler.enrich(uploadEvent());

    expect(result?.status).toBe("skipped");
  });
});
