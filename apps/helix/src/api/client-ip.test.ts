import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { trustedProxyAddresses } from "./client-ip.js";

describe("trusted proxy chain", () => {
  it("accepts only literal IP/CIDR entries and removes duplicates", () => {
    expect(trustedProxyAddresses("10.0.0.1, 2001:db8::/48,10.0.0.1")).toEqual([
      "10.0.0.1",
      "2001:db8::/48",
    ]);
    for (const invalid of [
      "*",
      "loopback",
      "0.0.0.0/0",
      "10.0.0.0/33",
      "2001:db8::/129",
      "host/path/x",
    ]) {
      expect(() => trustedProxyAddresses(invalid)).toThrow("HELIX_TRUSTED_PROXIES");
    }
  });

  it("ignores spoofed forwarding headers from untrusted peers", async () => {
    const app = fastify({ trustProxy: [...trustedProxyAddresses("10.0.0.1")] });
    app.get("/ip", async (request) => ({ ip: request.ip }));
    const response = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "198.51.100.2",
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(response.json()).toEqual({ ip: "198.51.100.2" });
    await app.close();
  });

  it("uses the real client behind an explicitly trusted proxy", async () => {
    const app = fastify({ trustProxy: [...trustedProxyAddresses("10.0.0.1")] });
    app.get("/ip", async (request) => ({ ip: request.ip }));
    const response = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(response.json()).toEqual({ ip: "203.0.113.9" });
    await app.close();
  });
});
