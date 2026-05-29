import { describe, expect, it, vi } from "vitest";
import type { AuthFetch } from "@/lib/auth";
import { fetchUsageRollups } from "./billing-api";

describe("billing-api", () => {
  it("fetches metering usage rollups with optional filters", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          rollups: [
            {
              orgId: "org-1",
              periodStart: "2026-05-23",
              periodEnd: "2026-05-24",
              metricKey: "storage_avg_bytes",
              quantity: 123,
              computedAt: "2026-05-24T00:05:00.000Z",
            },
          ],
          summary: {
            periodStart: "2026-05-23",
            periodEnd: "2026-05-24",
            metrics: [
              {
                metricKey: "storage_avg_bytes",
                quantity: 123,
                aggregation: "average",
                sampleCount: 1,
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await fetchUsageRollups(
      { from: "2026-05-01", to: "2026-05-31", metricKey: "storage_avg_bytes" },
      fetchImpl,
    );

    expect(result.rollups[0]?.quantity).toBe(123);
    expect(result.rollups[0]?.metricKey).toBe("storage_avg_bytes");
    expect(result.summary.metrics[0]).toMatchObject({
      metricKey: "storage_avg_bytes",
      aggregation: "average",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/admin/billing/usage?from=2026-05-01&to=2026-05-31&metricKey=storage_avg_bytes",
      { method: "GET" },
    );
  });

  it("defaults usage summary for older responses", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(
      new Response(JSON.stringify({ rollups: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await fetchUsageRollups({}, fetchImpl);

    expect(result.summary).toEqual({ periodStart: null, periodEnd: null, metrics: [] });
  });

  it("rejects malformed usage rollup responses at the boundary", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(
      new Response(JSON.stringify({ rollups: [{ metricKey: "ai_tokens" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(fetchUsageRollups({}, fetchImpl)).rejects.toThrow("malformed response");
  });

  it("rejects unknown usage rollup metric keys at the boundary", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          rollups: [
            {
              orgId: "org-1",
              periodStart: "2026-05-23",
              periodEnd: "2026-05-24",
              metricKey: "custom_metric",
              quantity: 123,
              computedAt: "2026-05-24T00:05:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(fetchUsageRollups({}, fetchImpl)).rejects.toThrow("malformed response");
  });
});
