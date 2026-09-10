import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { ReadinessMonitor, registerHealthRoutes } from "./readiness.js";

const requiredProbeIds = [
  "database",
  "migrations",
  "object-storage",
  "redis",
  "event-queue",
  "search",
  "identity-keys",
  "antivirus",
  "audit",
  "workers",
] as const;

describe("ReadinessMonitor", () => {
  it.each(requiredProbeIds)(
    "removes the pod from readiness when required %s is unavailable",
    async (failedId) => {
      const monitor = new ReadinessMonitor(
        requiredProbeIds.map((id) => ({
          id,
          check: async () => {
            if (id === failedId) throw new Error(`private ${id} diagnostic`);
          },
        })),
        { cacheMs: 0 },
      );
      const app = fastify();
      registerHealthRoutes(app, monitor);

      const response = await app.inject({ method: "GET", url: "/readyz" });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ ok: false });
      expect(response.body).not.toContain(failedId);
      await app.close();
    },
  );

  it("fails closed when any required probe fails without exposing its error", async () => {
    const monitor = new ReadinessMonitor(
      [
        { id: "database", check: async () => undefined },
        {
          id: "storage",
          check: async () => {
            throw new Error("secret endpoint and credential details");
          },
        },
      ],
      { cacheMs: 0 },
    );

    await expect(monitor.check()).resolves.toMatchObject({
      ok: false,
      failedProbeIds: ["storage"],
    });
  });

  it("bounds a hung dependency", async () => {
    const monitor = new ReadinessMonitor(
      [{ id: "queue", check: () => new Promise(() => undefined) }],
      { cacheMs: 0, timeoutMs: 5 },
    );

    await expect(monitor.check()).resolves.toMatchObject({ ok: false, failedProbeIds: ["queue"] });
  });

  it("coalesces and caches concurrent checks", async () => {
    let now = new Date("2026-09-02T00:00:00.000Z");
    const check = vi.fn(async () => undefined);
    const monitor = new ReadinessMonitor([{ id: "database", check }], {
      cacheMs: 5_000,
      now: () => now,
    });

    await Promise.all([monitor.check(), monitor.check()]);
    await monitor.check();
    expect(check).toHaveBeenCalledTimes(1);

    now = new Date("2026-09-02T00:00:05.000Z");
    await monitor.check();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("keeps liveness process-only and readiness diagnostics private", async () => {
    const app = fastify();
    registerHealthRoutes(
      app,
      new ReadinessMonitor(
        [
          {
            id: "secret-storage-host",
            check: async () => {
              throw new Error("s3://private-bucket");
            },
          },
        ],
        { cacheMs: 0 },
      ),
    );

    const live = await app.inject({ method: "GET", url: "/healthz" });
    const ready = await app.inject({ method: "GET", url: "/readyz" });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ ok: true });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ ok: false });
    expect(ready.body).not.toContain("storage");
    expect(ready.headers["cache-control"]).toBe("no-store");
    await app.close();
  });
});
