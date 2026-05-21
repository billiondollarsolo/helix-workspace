import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withJobSpan } from "./job-span.js";
import { installSpanCapture, type SpanCaptureHarness } from "./span-testing.js";

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
      const result = await withJobSpan("outbox-drain", async () => 42);
      expect(result).toBe(42);
      const span = harness.spans().find((candidate) => candidate.name === "job.outbox-drain");
      expect(span).toBeDefined();
      expect(span?.attributes["helix.job.id"]).toBe("outbox-drain");
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
});
