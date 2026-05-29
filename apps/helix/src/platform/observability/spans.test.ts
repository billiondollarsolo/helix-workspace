import { trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withJobSpan } from "./job-span.js";
import { installSpanCapture, type SpanCaptureHarness } from "./span-testing.js";
import { enrichActiveSpanWithTenant } from "./tenant-span.js";

describe("custom OTel span coverage (P2-6)", () => {
  let harness: SpanCaptureHarness;

  beforeEach(() => {
    harness = installSpanCapture();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  describe("withJobSpan", () => {
    it("emits a job.<id> span around a background-worker run", async () => {
      const result = await withJobSpan(
        "outbox-drain",
        async () => 42,
        {
          tenant: {
            orgId: "11111111-1111-4111-8111-111111111111",
            orgSlug: "acme",
            orgTier: "business",
            orgRegion: "us-east-1",
          },
        },
      );
      expect(result).toBe(42);
      const span = harness.spans().find((candidate) => candidate.name === "job.outbox-drain");
      expect(span).toBeDefined();
      expect(span?.attributes["helix.job.id"]).toBe("outbox-drain");
      expect(span?.attributes).toMatchObject({
        org_id: "11111111-1111-4111-8111-111111111111",
        "helix.tenant.org_id": "11111111-1111-4111-8111-111111111111",
        "helix.tenant.slug": "acme",
        "helix.tenant.tier": "business",
        "helix.tenant.region": "us-east-1",
      });
    });

    it("records the exception and error status, then re-throws", async () => {
      await expect(
        withJobSpan("pending-action-expiry", async () => {
          throw new Error("sweep failed");
        }),
      ).rejects.toThrow("sweep failed");
      const span = harness
        .spans()
        .find((candidate) => candidate.name === "job.pending-action-expiry");
      expect(span?.status.code).toBe(2 /* SpanStatusCode.ERROR */);
      expect(span?.events.some((event) => event.name === "exception")).toBe(true);
    });
  });

  describe("enrichActiveSpanWithTenant", () => {
    it("sets org_id and bounded tenant attributes on the active span", () => {
      const result = trace.getTracer("helix.test").startActiveSpan("http.request", (span) => {
        try {
          return enrichActiveSpanWithTenant({
            orgId: "11111111-1111-4111-8111-111111111111",
            orgSlug: "acme",
            orgTier: "business",
            orgRegion: "us-east-1",
          });
        } finally {
          span.end();
        }
      });

      expect(result).toBe(true);
      const span = harness.spans().find((candidate) => candidate.name === "http.request");
      expect(span?.attributes).toMatchObject({
        org_id: "11111111-1111-4111-8111-111111111111",
        "helix.tenant.org_id": "11111111-1111-4111-8111-111111111111",
        "helix.tenant.slug": "acme",
        "helix.tenant.tier": "business",
        "helix.tenant.region": "us-east-1",
      });
    });

    it("copies tenant attributes from an enriched parent span to child spans", () => {
      trace.getTracer("helix.test").startActiveSpan("http.request", (parentSpan) => {
        try {
          enrichActiveSpanWithTenant({
            orgId: "11111111-1111-4111-8111-111111111111",
            orgSlug: "acme",
            orgTier: "business",
            orgRegion: "us-east-1",
          });
          const childSpan = trace.getTracer("helix.test").startSpan("tool.mail.search");
          childSpan.end();
        } finally {
          parentSpan.end();
        }
      });

      const childSpan = harness.spans().find((candidate) => candidate.name === "tool.mail.search");
      expect(childSpan?.attributes).toMatchObject({
        org_id: "11111111-1111-4111-8111-111111111111",
        "helix.tenant.org_id": "11111111-1111-4111-8111-111111111111",
        "helix.tenant.slug": "acme",
        "helix.tenant.tier": "business",
        "helix.tenant.region": "us-east-1",
      });
    });

    it("is a no-op when no span is active", () => {
      expect(
        enrichActiveSpanWithTenant({
          orgId: "11111111-1111-4111-8111-111111111111",
          orgSlug: "acme",
          orgTier: "business",
          orgRegion: "us-east-1",
        }),
      ).toBe(false);
    });
  });
});
