export interface SignupRecaptchaVerifyInput {
  readonly token: string | undefined;
  readonly ip: string;
}

export type SignupRecaptchaVerifyResult =
  | {
      readonly allowed: true;
      readonly score: number | null;
      readonly action: string | null;
    }
  | {
      readonly allowed: false;
      readonly reason: "missing_token" | "invalid_token" | "low_score" | "verification_unavailable";
      readonly score?: number | undefined;
      readonly action?: string | undefined;
    };

export interface SignupRecaptchaVerifier {
  verify(input: SignupRecaptchaVerifyInput): Promise<SignupRecaptchaVerifyResult>;
}

export interface GoogleRecaptchaVerifierOptions {
  readonly secret: string;
  readonly minScore?: number;
  readonly expectedAction?: string;
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
}

const defaultMinScore = 0.5;
const defaultExpectedAction = "signup";

export class GoogleRecaptchaVerifier implements SignupRecaptchaVerifier {
  private readonly secret: string;
  private readonly minScore: number;
  private readonly expectedAction: string;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(options: GoogleRecaptchaVerifierOptions) {
    this.secret = options.secret;
    this.minScore = options.minScore ?? defaultMinScore;
    this.expectedAction = options.expectedAction ?? defaultExpectedAction;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? "https://www.google.com/recaptcha/api/siteverify";
  }

  async verify(input: SignupRecaptchaVerifyInput): Promise<SignupRecaptchaVerifyResult> {
    if (input.token === undefined || input.token.trim().length === 0) {
      return { allowed: false, reason: "missing_token" };
    }

    const body = new URLSearchParams({
      secret: this.secret,
      response: input.token,
      remoteip: input.ip,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch {
      return { allowed: false, reason: "verification_unavailable" };
    }
    if (!response.ok) {
      return { allowed: false, reason: "verification_unavailable" };
    }

    const parsed = googleRecaptchaResponse(await response.json().catch(() => ({})));
    if (!parsed.success) {
      return { allowed: false, reason: "invalid_token" };
    }
    if (parsed.action !== null && parsed.action !== this.expectedAction) {
      return { allowed: false, reason: "invalid_token", action: parsed.action };
    }
    if (parsed.score !== null && parsed.score < this.minScore) {
      return {
        allowed: false,
        reason: "low_score",
        score: parsed.score,
        ...(parsed.action === null ? {} : { action: parsed.action }),
      };
    }

    return {
      allowed: true,
      score: parsed.score,
      action: parsed.action,
    };
  }
}

function googleRecaptchaResponse(value: unknown): {
  readonly success: boolean;
  readonly score: number | null;
  readonly action: string | null;
} {
  if (typeof value !== "object" || value === null) {
    return { success: false, score: null, action: null };
  }
  const record = value as Record<string, unknown>;
  return {
    success: record.success === true,
    score: typeof record.score === "number" && Number.isFinite(record.score) ? record.score : null,
    action: typeof record.action === "string" ? record.action : null,
  };
}
