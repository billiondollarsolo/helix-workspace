import { expect, it } from "vitest";
import { createRecordingSql } from "../../test-support/recording-sql.js";
import { PostgresPlatformConfigStore, platformConfigUpdateSchema } from "./admin.js";

it("rejects an unenforced PII-redaction promise", () => {
  const result = platformConfigUpdateSchema.safeParse({
    ai: { privacy: { redactPIIBeforeSend: true } },
  });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues[0]?.message).toContain("not supported");
});

it("loads a persisted redaction request so the provider guard can block it and administrators can correct it", async () => {
  const recording = createRecordingSql(
    [[{ key: "ai", value: { enabled: true, privacy: { redactPIIBeforeSend: true } } }]],
    "$",
  );
  const config = await new PostgresPlatformConfigStore(recording.sql).loadOverrides();
  expect(config.ai?.privacy?.redactPIIBeforeSend).toBe(true);
});
