export interface SignupPasswordStrengthInput {
  readonly password: string;
  readonly email: string;
  readonly orgName: string;
}

export interface SignupPasswordStrength {
  readonly score: number;
  readonly acceptable: boolean;
  readonly label: string;
}

const minScore = 3;
const predictableTerms = ["password", "qwerty", "letmein", "welcome", "administrator"];

export async function evaluateSignupPasswordStrength(
  input: SignupPasswordStrengthInput,
): Promise<SignupPasswordStrength> {
  const score = scoreSignupPassword(input);
  return {
    score,
    acceptable: score >= minScore,
    label: passwordStrengthLabel(score),
  };
}

export function preloadSignupPasswordStrengthEstimator(): Promise<void> {
  return Promise.resolve();
}

function scoreSignupPassword(input: SignupPasswordStrengthInput): number {
  if (input.password.length < 12) {
    return 0;
  }
  const normalized = input.password.toLowerCase();
  if (
    [...predictableTerms, ...contextualPasswordTerms(input)].some(
      (term) => term.length >= 3 && normalized.includes(term),
    ) ||
    /^(.)\1+$/u.test(normalized) ||
    /(?:012345|123456|abcdef|qwerty)/u.test(normalized)
  ) {
    return 0;
  }
  const alphabet =
    (/[a-z]/u.test(input.password) ? 26 : 0) +
    (/[A-Z]/u.test(input.password) ? 26 : 0) +
    (/\d/u.test(input.password) ? 10 : 0) +
    (/[^A-Za-z0-9]/u.test(input.password) ? 32 : 0);
  const entropy = input.password.length * Math.log2(alphabet);
  return entropy >= 100 ? 4 : entropy >= 70 ? 3 : entropy >= 50 ? 2 : 1;
}

function passwordStrengthLabel(score: number): string {
  if (score >= minScore) {
    return "Password strength accepted.";
  }
  if (score === 0) {
    return "Use at least 12 less predictable characters.";
  }
  return "Use a longer, less predictable password.";
}

function contextualPasswordTerms(input: SignupPasswordStrengthInput): readonly string[] {
  const [emailLocal, emailDomain] = input.email.toLowerCase().split("@");
  return [
    input.email.toLowerCase(),
    emailLocal ?? "",
    emailDomain?.split(".")[0] ?? "",
    ...input.orgName.toLowerCase().split(/[^a-z0-9]+/u),
  ].filter((term) => term.length > 0);
}
