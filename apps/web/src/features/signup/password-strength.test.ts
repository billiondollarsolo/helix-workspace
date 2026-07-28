import { describe, expect, it } from "vitest";
import { evaluateSignupPasswordStrength } from "./password-strength";

describe("evaluateSignupPasswordStrength", () => {
  it("accepts strong passphrases and rejects predictable passwords", async () => {
    expect(
      (
        await evaluateSignupPasswordStrength({
          email: "owner@example.com",
          orgName: "Acme",
          password: "correct-horse-battery-staple",
        })
      ).acceptable,
    ).toBe(true);

    expect(
      (
        await evaluateSignupPasswordStrength({
          email: "owner@example.com",
          orgName: "Acme",
          password: "passwordpassword",
        })
      ).acceptable,
    ).toBe(false);
  });

  it("rejects passwords based on owner or organization context", async () => {
    expect(
      (
        await evaluateSignupPasswordStrength({
          email: "owner@acme.example",
          orgName: "Acme Labs",
          password: "ownerownerowner",
        })
      ).acceptable,
    ).toBe(false);
  });
});
