import zxcvbn from "zxcvbn";

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

export function evaluateSignupPasswordStrength(
  input: SignupPasswordStrengthInput,
): SignupPasswordStrength {
  const score = scoreSignupPassword(input);
  return {
    score,
    acceptable: score >= minScore,
    label: passwordStrengthLabel(score),
  };
}

function scoreSignupPassword(input: SignupPasswordStrengthInput): number {
  if (input.password.length < 12) {
    return 0;
  }
  return zxcvbn(input.password, [...contextualPasswordTerms(input)]).score;
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
