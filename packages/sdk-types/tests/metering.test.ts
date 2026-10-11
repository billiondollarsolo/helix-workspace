import { describe, expect, it } from "vitest";
import {
  isMeteringRollupMetricKey,
  meteringRollupMetricKeyByEventType,
  meteringRollupMetricKeys,
} from "../src/metering.js";

describe("metering rollup metric keys", () => {
  it("defines the canonical additive and daily-average rollup keys", () => {
    expect(meteringRollupMetricKeys).toEqual([
      "ai_tokens",
      "storage_delta_bytes",
      "exports_count",
      "ai_images_generated",
      "storage_avg_bytes",
    ]);
  });

  it("maps every metering event type to a canonical rollup key", () => {
    expect(meteringRollupMetricKeyByEventType).toEqual({
      "ai.tokens": "ai_tokens",
      "ai.image.generated": "ai_images_generated",
      "storage.delta": "storage_delta_bytes",
      "export.completed": "exports_count",
    });
  });

  it("guards unknown rollup keys", () => {
    expect(isMeteringRollupMetricKey("ai_tokens")).toBe(true);
    expect(isMeteringRollupMetricKey("storage_avg_bytes")).toBe(true);
    expect(isMeteringRollupMetricKey("exports_count")).toBe(true);
    expect(isMeteringRollupMetricKey("custom_metric")).toBe(false);
  });
});
