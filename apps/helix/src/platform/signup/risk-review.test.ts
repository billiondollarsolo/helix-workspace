import { describe, expect, it } from "vitest";
import {
  ConfiguredCountrySignupRiskReviewer,
  parseSignupManualReviewCountries,
} from "./risk-review.js";

describe("ConfiguredCountrySignupRiskReviewer", () => {
  it("flags configured countries for non-blocking manual review", async () => {
    const reviewer = new ConfiguredCountrySignupRiskReviewer({
      manualReviewCountries: ["br", "za"],
    });

    await expect(
      reviewer.review({
        country: "br",
        phone: "+5511999999999",
      }),
    ).resolves.toEqual({
      required: true,
      country: "BR",
      reasons: ["configured_high_risk_country"],
      smsGuidance: "consider_sms_mfa_review",
    });
    await expect(
      reviewer.review({
        country: "ZA",
      }),
    ).resolves.toEqual({
      required: true,
      country: "ZA",
      reasons: ["configured_high_risk_country"],
      smsGuidance: "missing_phone_for_sms_review",
    });
  });

  it("allows non-configured countries without a review flag", async () => {
    const reviewer = new ConfiguredCountrySignupRiskReviewer({
      manualReviewCountries: ["BR"],
    });

    await expect(reviewer.review({ country: "US" })).resolves.toEqual({ required: false });
  });
});

describe("parseSignupManualReviewCountries", () => {
  it("normalizes comma-separated ISO country codes and drops invalid entries", () => {
    expect(parseSignupManualReviewCountries(" br, ZA, usa, 1x, DE ")).toEqual([
      "BR",
      "ZA",
      "DE",
    ]);
  });
});
