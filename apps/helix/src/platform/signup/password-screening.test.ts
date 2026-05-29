import { describe, expect, it, vi } from "vitest";
import {
  DefaultSignupPasswordScreener,
  HaveIBeenPwnedPasswordChecker,
  parsePwnedPasswordRange,
  scoreSignupPassword,
} from "./password-screening.js";

describe("scoreSignupPassword", () => {
  it("requires more than length-only predictable passwords", () => {
    expect(
      scoreSignupPassword({
        email: "owner@example.com",
        orgName: "Acme",
        password: "passwordpassword",
      }),
    ).toBeLessThan(3);
    expect(
      scoreSignupPassword({
        email: "owner@example.com",
        orgName: "Acme",
        password: "correct-horse-battery-staple",
      }),
    ).toBeGreaterThanOrEqual(3);
  });

  it("penalizes contextual owner and organization terms", () => {
    expect(
      scoreSignupPassword({
        email: "owner@acme.example",
        orgName: "Acme Labs",
        password: "ownerownerowner",
      }),
    ).toBeLessThan(3);
  });
});

describe("DefaultSignupPasswordScreener", () => {
  it("rejects weak passwords before breach lookup", async () => {
    const pwnedPasswords = { breachCount: vi.fn(async () => 0) };
    const screener = new DefaultSignupPasswordScreener({ pwnedPasswords });

    await expect(
      screener.check({
        email: "owner@example.com",
        orgName: "Acme",
        password: "passwordpassword",
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "weak_password",
    });
    expect(pwnedPasswords.breachCount).not.toHaveBeenCalled();
  });

  it("rejects breached passwords returned by the pwned-password checker", async () => {
    const screener = new DefaultSignupPasswordScreener({
      pwnedPasswords: { breachCount: async () => 42 },
    });

    await expect(
      screener.check({
        email: "owner@example.com",
        orgName: "Acme",
        password: "correct-horse-battery-staple",
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: "breached_password",
      breachCount: 42,
    });
  });

  it("fails closed when breach lookup is unavailable", async () => {
    const screener = new DefaultSignupPasswordScreener({
      pwnedPasswords: {
        async breachCount() {
          throw new Error("network unavailable");
        },
      },
    });

    await expect(
      screener.check({
        email: "owner@example.com",
        orgName: "Acme",
        password: "correct-horse-battery-staple",
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: "screening_unavailable",
    });
  });
});

describe("HaveIBeenPwnedPasswordChecker", () => {
  it("uses the k-anonymity range API and returns the matching suffix count", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          ["00000000000000000000000000000000000:1", "22AE348AEB5660FC2140AEC35850C4DA997:120"].join(
            "\r\n",
          ),
        ),
      );
    const checker = new HaveIBeenPwnedPasswordChecker({
      fetchImpl,
      baseUrl: "https://hibp.test/range",
    });

    await expect(checker.breachCount("admin")).resolves.toBe(120);
    expect(fetchImpl).toHaveBeenCalledWith("https://hibp.test/range/D033E", {
      method: "GET",
      headers: {
        "add-padding": "true",
        "user-agent": "helix-signup-password-screening",
      },
    });
  });
});

describe("parsePwnedPasswordRange", () => {
  it("parses valid suffix counts and ignores malformed padding lines", () => {
    expect(
      parsePwnedPasswordRange("ABCDEFABCDEFABCDEFABCDEFABCDEFABCDE:3\nnot-valid\n").get(
        "ABCDEFABCDEFABCDEFABCDEFABCDEFABCDE",
      ),
    ).toBe(3);
  });
});
