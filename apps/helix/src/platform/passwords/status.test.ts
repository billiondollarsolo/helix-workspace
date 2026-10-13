import { describe, expect, it } from "vitest";
import { resolvePasswordsStatus } from "./status.js";

describe("resolvePasswordsStatus", () => {
  it("links to the password manager only when it is installed and turned on", () => {
    expect(resolvePasswordsStatus("https://vault.example.test", true)).toEqual({
      installed: true,
      enabled: true,
      url: "https://vault.example.test",
    });
    expect(resolvePasswordsStatus("https://vault.example.test", false)).toEqual({
      installed: true,
      enabled: false,
      url: null,
    });
    // Turned on, but this deployment does not run one.
    expect(resolvePasswordsStatus(undefined, true)).toEqual({
      installed: false,
      enabled: true,
      url: null,
    });
  });
});
