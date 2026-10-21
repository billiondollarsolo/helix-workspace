import { describe, expect, it } from "vitest";
import { parseFederationRoutes } from "./federation-pairing.js";

describe("HELIX_FEDERATION_ROUTES", () => {
  it("maps public hostnames to private targets", () => {
    expect(
      parseFederationRoutes(
        "Agentspace.Example=helix-agentspace:3000, tools.example=10.0.0.5:8443",
      ),
    ).toEqual(
      new Map([
        ["agentspace.example", { host: "helix-agentspace", port: 3000 }],
        ["tools.example", { host: "10.0.0.5", port: 8443 }],
      ]),
    );
    expect(parseFederationRoutes(undefined).size).toBe(0);
  });

  it.each(["agentspace.example", "agentspace.example=helix", "a=b:0", "a=b:70000", "=b:1"])(
    "rejects %s",
    (value) => {
      expect(() => parseFederationRoutes(value)).toThrow("HELIX_FEDERATION_ROUTES");
    },
  );
});
