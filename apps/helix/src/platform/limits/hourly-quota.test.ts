import { describe, expect, it } from "vitest";
import {
  InMemoryTenantHourlyQuotaLimiter,
  normalizeTenantHourlyQuotaLimit,
  RedisTenantHourlyQuotaLimiter,
} from "./index.js";

const orgId = "11111111-1111-4111-8111-111111111111";

describe("Tenant hourly quota limiters", () => {
  it("enforces a per-tenant hourly count window in memory", async () => {
    const limiter = new InMemoryTenantHourlyQuotaLimiter();
    const at = new Date("2026-05-24T12:00:00.000Z");

    await expect(
      limiter.consume({ orgId, quota: "export_jobs_per_hour", limit: 1, at }),
    ).resolves.toMatchObject({
      allowed: true,
      quota: "export_jobs_per_hour",
      limit: 1,
      used: 1,
      remaining: 0,
    });

    await expect(
      limiter.consume({
        orgId,
        quota: "export_jobs_per_hour",
        limit: 1,
        at: new Date(at.getTime() + 1_000),
      }),
    ).resolves.toMatchObject({
      allowed: false,
      quota: "export_jobs_per_hour",
      limit: 1,
      used: 1,
      remaining: 0,
      retryAfterSeconds: 3_599,
    });

    await expect(
      limiter.consume({
        orgId,
        quota: "export_jobs_per_hour",
        limit: 1,
        at: new Date(at.getTime() + 3_601_000),
      }),
    ).resolves.toMatchObject({ allowed: true, used: 1 });
  });

  it("treats a null hourly quota as unlimited", async () => {
    const limiter = new InMemoryTenantHourlyQuotaLimiter();
    const at = new Date("2026-05-24T12:00:00.000Z");

    await limiter.consume({ orgId, quota: "export_jobs_per_hour", limit: null, at });
    await expect(
      limiter.consume({ orgId, quota: "export_jobs_per_hour", limit: null, at }),
    ).resolves.toMatchObject({
      allowed: true,
      limit: null,
      used: 2,
      remaining: null,
    });
  });

  it("rejects invalid hourly quota limits", () => {
    expect(() => normalizeTenantHourlyQuotaLimit("export_jobs_per_hour", -1)).toThrow(
      "export_jobs_per_hour",
    );
    expect(() => normalizeTenantHourlyQuotaLimit("export_jobs_per_hour", 1.5)).toThrow(
      "export_jobs_per_hour",
    );
  });

  it("uses Redis with org and quota scoped keys", async () => {
    const calls: readonly unknown[][] = [];
    const redis = {
      async eval(...args: unknown[]) {
        (calls as unknown[][]).push(args);
        return [0, 2, 3599, Date.parse("2026-05-24T12:00:00.000Z")];
      },
    };
    const limiter = new RedisTenantHourlyQuotaLimiter(redis, { keyPrefix: "test:quota" });

    await expect(
      limiter.consume({
        orgId: "org.with spaces",
        quota: "export.jobs/hour",
        limit: 2,
        at: new Date("2026-05-24T12:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      allowed: false,
      quota: "export.jobs/hour",
      limit: 2,
      used: 2,
      retryAfterSeconds: 3599,
    });

    expect(calls[0]?.[1]).toBe(1);
    expect(calls[0]?.[2]).toBe("test:quota:{org_with_spaces}:export_jobs_hour");
    expect(calls[0]?.[5]).toBe(2);
  });
});
