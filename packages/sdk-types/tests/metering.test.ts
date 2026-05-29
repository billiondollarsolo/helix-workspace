import { describe, expect, it } from "vitest";
import {
  isMeteringRollupMetricKey,
  meteringRollupMetricKeyByEventType,
  meteringRollupMetricKeys,
} from "../src/metering.js";

describe("metering rollup metric keys", () => {
  it("defines the canonical additive and billing-grade rollup keys", () => {
    expect(meteringRollupMetricKeys).toEqual([
      "ai_tokens",
      "storage_delta_bytes",
      "exports_count",
      "api_calls_billable",
      "ai_images_generated",
      "seats_delta",
      "seats_max",
      "collab_session_seconds",
      "storage_avg_bytes",
    ]);
  });

  it("maps every metering event type to a canonical rollup key", () => {
    expect(meteringRollupMetricKeyByEventType).toEqual({
      "ai.tokens": "ai_tokens",
      "ai.image.generated": "ai_images_generated",
      "storage.delta": "storage_delta_bytes",
      "seats.delta": "seats_delta",
      "export.completed": "exports_count",
      "collab.session.opened": "collab_session_seconds",
      "api.call.billable": "api_calls_billable",
    });
  });

  it("guards unknown rollup keys", () => {
    expect(isMeteringRollupMetricKey("ai_tokens")).toBe(true);
    expect(isMeteringRollupMetricKey("storage_avg_bytes")).toBe(true);
    expect(isMeteringRollupMetricKey("seats_max")).toBe(true);
    expect(isMeteringRollupMetricKey("custom_metric")).toBe(false);
  });
});
