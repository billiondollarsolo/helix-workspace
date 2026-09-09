import { describe, expect, it, vi } from "vitest";
import { createJibriRecorderHealthCheck } from "./recorder-health.js";

describe("Jibri recorder health", () => {
  it("reports available only for a healthy idle recorder", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ status: { busyStatus: "IDLE", health: { healthStatus: "HEALTHY" } } }),
      );
    await expect(
      createJibriRecorderHealthCheck(
        "http://jibri.internal:2222/jibri/api/v1.0/health",
        fetchImpl,
      )(),
    ).resolves.toBe(true);
  });

  it.each([
    { status: { busyStatus: "BUSY", health: { healthStatus: "HEALTHY" } } },
    { status: { busyStatus: "IDLE", health: { healthStatus: "UNHEALTHY" } } },
    {},
  ])("reports unavailable for non-ready payload %#", async (payload) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    await expect(
      createJibriRecorderHealthCheck("https://jibri.example/health", fetchImpl)(),
    ).resolves.toBe(false);
  });

  it("fails closed on transport and HTTP errors", async () => {
    const rejected = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const unavailable = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    await expect(
      createJibriRecorderHealthCheck("https://jibri.example/health", rejected)(),
    ).resolves.toBe(false);
    await expect(
      createJibriRecorderHealthCheck("https://jibri.example/health", unavailable)(),
    ).resolves.toBe(false);
  });
});
