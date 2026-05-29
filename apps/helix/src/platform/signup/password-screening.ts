import { createHash } from "node:crypto";
import zxcvbn from "zxcvbn";

export interface SignupPasswordScreeningInput {
  readonly password: string;
  readonly email: string;
  readonly orgName: string;
}

export type SignupPasswordScreeningResult =
  | {
      readonly allowed: true;
      readonly score: number;
      readonly minScore: number;
    }
  | {
      readonly allowed: false;
      readonly reason: "weak_password";
      readonly score: number;
      readonly minScore: number;
    }
  | {
      readonly allowed: false;
      readonly reason: "breached_password";
      readonly breachCount: number;
    }
  | {
      readonly allowed: false;
      readonly reason: "screening_unavailable";
    };

export interface SignupPasswordScreener {
  check(input: SignupPasswordScreeningInput): Promise<SignupPasswordScreeningResult>;
}

export interface PwnedPasswordChecker {
  breachCount(password: string): Promise<number>;
}

export interface DefaultSignupPasswordScreenerOptions {
  readonly minScore?: number;
  readonly pwnedPasswords?: PwnedPasswordChecker | undefined;
}

const defaultMinScore = 3;

export class DefaultSignupPasswordScreener implements SignupPasswordScreener {
  private readonly minScore: number;
  private readonly pwnedPasswords: PwnedPasswordChecker | undefined;

  constructor(options: DefaultSignupPasswordScreenerOptions = {}) {
    this.minScore = options.minScore ?? defaultMinScore;
    this.pwnedPasswords = options.pwnedPasswords;
  }

  async check(input: SignupPasswordScreeningInput): Promise<SignupPasswordScreeningResult> {
    const score = scoreSignupPassword(input);
    if (score < this.minScore) {
      return {
        allowed: false,
        reason: "weak_password",
        score,
        minScore: this.minScore,
      };
    }

    if (this.pwnedPasswords !== undefined) {
      let breachCount: number;
      try {
        breachCount = await this.pwnedPasswords.breachCount(input.password);
      } catch {
        return {
          allowed: false,
          reason: "screening_unavailable",
        };
      }
      if (breachCount > 0) {
        return {
          allowed: false,
          reason: "breached_password",
          breachCount,
        };
      }
    }

    return {
      allowed: true,
      score,
      minScore: this.minScore,
    };
  }
}

export interface HaveIBeenPwnedPasswordCheckerOptions {
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  readonly userAgent?: string;
}

export class HaveIBeenPwnedPasswordChecker implements PwnedPasswordChecker {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly userAgent: string;

  constructor(options: HaveIBeenPwnedPasswordCheckerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.pwnedpasswords.com/range";
    this.userAgent = options.userAgent ?? "helix-signup-password-screening";
  }

  async breachCount(password: string): Promise<number> {
    const hash = sha1Upper(password);
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const response = await this.fetchImpl(`${this.baseUrl}/${prefix}`, {
      method: "GET",
      headers: {
        "add-padding": "true",
        "user-agent": this.userAgent,
      },
    });
    if (!response.ok) {
      throw new Error(`HIBP password range lookup failed with ${String(response.status)}`);
    }
    return parsePwnedPasswordRange(await response.text()).get(suffix) ?? 0;
  }
}

export function scoreSignupPassword(input: SignupPasswordScreeningInput): number {
  if (input.password.length < 12) {
    return 0;
  }
  return zxcvbn(input.password, [...contextualPasswordTerms(input)]).score;
}

export function parsePwnedPasswordRange(body: string): ReadonlyMap<string, number> {
  const entries = new Map<string, number>();
  for (const line of body.split(/\r?\n/u)) {
    const [suffix, count] = line.trim().split(":");
    if (suffix === undefined || count === undefined) {
      continue;
    }
    const normalizedSuffix = suffix.trim().toUpperCase();
    const parsedCount = Number.parseInt(count.trim(), 10);
    if (/^[A-F0-9]{35}$/u.test(normalizedSuffix) && Number.isFinite(parsedCount)) {
      entries.set(normalizedSuffix, parsedCount);
    }
  }
  return entries;
}

function contextualPasswordTerms(input: SignupPasswordScreeningInput): readonly string[] {
  const [emailLocal, emailDomain] = input.email.toLowerCase().split("@");
  return [
    input.email.toLowerCase(),
    emailLocal ?? "",
    emailDomain?.split(".")[0] ?? "",
    ...input.orgName.toLowerCase().split(/[^a-z0-9]+/u),
  ].filter((term) => term.length > 0);
}

function sha1Upper(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("hex").toUpperCase();
}
