export interface SignupRiskReviewInput {
  readonly country: string;
  readonly phone?: string | undefined;
}

export type SignupRiskReviewReason = "configured_high_risk_country";

export type SignupRiskReviewSmsGuidance =
  | "consider_sms_mfa_review"
  | "missing_phone_for_sms_review";

export type SignupRiskReviewDecision =
  | { readonly required: false }
  | {
      readonly required: true;
      readonly reasons: readonly SignupRiskReviewReason[];
      readonly country: string;
      readonly smsGuidance: SignupRiskReviewSmsGuidance;
    };

export interface SignupRiskReviewer {
  review(input: SignupRiskReviewInput): Promise<SignupRiskReviewDecision>;
}

export interface ConfiguredCountrySignupRiskReviewerOptions {
  readonly manualReviewCountries?: Iterable<string>;
}

export class ConfiguredCountrySignupRiskReviewer implements SignupRiskReviewer {
  private readonly manualReviewCountries: ReadonlySet<string>;

  constructor(options: ConfiguredCountrySignupRiskReviewerOptions = {}) {
    this.manualReviewCountries = normalizedCountrySet(options.manualReviewCountries);
  }

  async review(input: SignupRiskReviewInput): Promise<SignupRiskReviewDecision> {
    const country = normalizeCountry(input.country);
    if (!this.manualReviewCountries.has(country)) {
      return { required: false };
    }
    const hasPhone = input.phone !== undefined && input.phone.trim().length > 0;
    return {
      required: true,
      country,
      reasons: ["configured_high_risk_country"],
      smsGuidance: hasPhone ? "consider_sms_mfa_review" : "missing_phone_for_sms_review",
    };
  }
}

export function parseSignupManualReviewCountries(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(",")
    .map(normalizeCountry)
    .filter((country) => /^[A-Z]{2}$/u.test(country));
}

function normalizedCountrySet(countries: Iterable<string> | undefined): ReadonlySet<string> {
  return new Set([...(countries ?? [])].map(normalizeCountry).filter(isIsoCountryCode));
}

function normalizeCountry(country: string): string {
  return country.trim().toUpperCase();
}

function isIsoCountryCode(country: string): boolean {
  return /^[A-Z]{2}$/u.test(country);
}
