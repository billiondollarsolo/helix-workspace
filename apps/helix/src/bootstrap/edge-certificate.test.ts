import { describe, expect, it } from "vitest";
import { deploymentSource } from "./edge-certificate.js";

describe("deploymentSource", () => {
  it("reads the edge's tls setting the way Caddy does", () => {
    expect(deploymentSource(undefined)).toBe("automatic");
    expect(deploymentSource("")).toBe("automatic");
    expect(deploymentSource("automatic")).toBe("automatic");
    // Caddy treats a single email as automatic HTTPS with that ACME contact.
    expect(deploymentSource("ops@example.com")).toBe("automatic");
    expect(deploymentSource("internal")).toBe("internal");
    expect(deploymentSource("/run/secrets/tls_cert /run/secrets/tls_key")).toBe("files");
  });
});
