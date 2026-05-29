import { describe, expect, it } from "vitest";
import { extractVerificationToken, slugify } from "./synthetic-signup-probe.mjs";

describe("synthetic signup probe helpers", () => {
  it("extracts and decodes verification tokens from Mailpit message content", () => {
    expect(
      extractVerificationToken(
        'Open https://app.example/signup/verify-email?token=token%2Bwith%2Bspaces" now',
      ),
    ).toBe("token+with+spaces");
    expect(extractVerificationToken("no verification link")).toBeNull();
  });

  it("builds bounded lowercase org slug prefixes", () => {
    expect(slugify(" Synthetic Signup Probe! ")).toBe("synthetic-signup-probe");
    expect(slugify("")).toBe("synth");
    expect(slugify("A".repeat(40))).toHaveLength(24);
  });
});
