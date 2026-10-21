import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/test-actor.js";
import {
  dedupeDnsChecklistTargets,
  evaluateDnsChecklistRow,
  isCloudflareAddress,
  registerDnsChecklistRoutes,
} from "./dns-checklist.js";

const CF_V4 = "104.16.1.1";
const CF_V6 = "2606:4700::1111";
const DIRECT = "203.0.113.10";

describe("Cloudflare address ranges", () => {
  it("recognises proxy addresses in both families", () => {
    expect(isCloudflareAddress(CF_V4)).toBe(true);
    expect(isCloudflareAddress("172.71.255.255")).toBe(true);
    expect(isCloudflareAddress(CF_V6)).toBe(true);
    expect(isCloudflareAddress("2a06:98c7::1")).toBe(true);
    expect(isCloudflareAddress(DIRECT)).toBe(false);
    expect(isCloudflareAddress("2001:db8::1")).toBe(false);
    expect(isCloudflareAddress("not-an-ip")).toBe(false);
  });
});

describe("DNS checklist evaluation", () => {
  it("accepts a proxied web host and a direct mail host", () => {
    expect(evaluateDnsChecklistRow({ hostname: "w.example", role: "web" }, [CF_V4, CF_V6])).toEqual(
      {
        hostname: "w.example",
        role: "web",
        expected: "proxied",
        observed: "proxied",
        addresses: [CF_V4, CF_V6],
        status: "ok",
        advice: "",
      },
    );
    const mail = evaluateDnsChecklistRow({ hostname: "mx.example", role: "mail" }, [DIRECT]);
    expect(mail).toMatchObject({ expected: "dns-only", observed: "dns-only", status: "ok" });
  });

  it("flags proxied or mixed mail and TURN records as problems", () => {
    for (const addresses of [[CF_V4], [CF_V4, DIRECT]]) {
      for (const role of ["mail", "turn"] as const) {
        const row = evaluateDnsChecklistRow({ hostname: "h.example", role }, addresses);
        expect(row.status).toBe("problem");
        expect(row.observed).toBe(addresses.length === 1 ? "proxied" : "mixed");
        expect(row.advice).toBe(
          "Mail and TURN can’t pass through an HTTP proxy. Set this record to DNS-only.",
        );
      }
    }
  });

  it("recommends proxying direct web and app records", () => {
    for (const role of ["web", "app"] as const) {
      const row = evaluateDnsChecklistRow({ hostname: "h.example", role }, [DIRECT]);
      expect(row).toMatchObject({ expected: "proxied", observed: "dns-only", status: "recommend" });
      expect(row.advice).toBe(
        "Proxy this record and keep the origin locked to the proxy’s addresses.",
      );
    }
  });

  it("reports a hostname with no addresses as a problem", () => {
    const row = evaluateDnsChecklistRow({ hostname: "gone.example", role: "app" }, []);
    expect(row).toMatchObject({
      observed: "unresolved",
      status: "problem",
      advice: "This hostname doesn’t resolve.",
    });
  });

  it("keeps one row per hostname, preferring the stricter purpose", () => {
    expect(
      dedupeDnsChecklistTargets([
        { hostname: "Example.com.", role: "web" },
        { hostname: "example.com", role: "mail" },
        { hostname: "app.example.com", role: "app" },
        { hostname: "app.example.com", role: "web" },
      ]),
    ).toEqual([
      { hostname: "example.com", role: "mail" },
      { hostname: "app.example.com", role: "app" },
    ]);
  });
});

describe("DNS checklist route", () => {
  async function build() {
    const app = fastify();
    registerDnsChecklistRoutes(app, {
      actorFromRequest,
      targets: async () => [
        { hostname: "w.example", role: "web" },
        { hostname: "turn.example", role: "turn" },
      ],
      resolve: async (hostname) => {
        if (hostname === "turn.example") throw new Error("SERVFAIL");
        return [DIRECT];
      },
    });
    return app;
  }
  const headers = (scopes: string) => ({
    "x-helix-actor-id": "11111111-1111-4111-8111-111111111111",
    "x-helix-org-id": "22222222-2222-4222-8222-222222222222",
    "x-helix-scopes": scopes,
  });

  it("refuses people without admin read access", async () => {
    const app = await build();
    for (const scopes of ["", "mail.read"]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/domains/dns-checklist",
        headers: headers(scopes),
      });
      expect(response.statusCode).toBe(403);
    }
    const anonymous = await app.inject({ method: "GET", url: "/api/admin/domains/dns-checklist" });
    expect(anonymous.statusCode).toBe(403);
  });

  it("lists every hostname for administrators and reports lookup failures", async () => {
    const app = await build();
    for (const scopes of ["admin.console.read", "admin.domains"]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/domains/dns-checklist",
        headers: headers(scopes),
      });
      expect(response.statusCode).toBe(200);
      const { rows } = response.json<{ rows: { hostname: string; status: string }[] }>();
      expect(rows.map((row) => [row.hostname, row.status])).toEqual([
        ["w.example", "recommend"],
        ["turn.example", "problem"],
      ]);
    }
  });
});
