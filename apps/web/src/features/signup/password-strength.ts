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
type PasswordEstimator = typeof estimatePassword;
interface PasswordEstimatorModule {
  readonly default: PasswordEstimator;
}
let passwordEstimatorPromise: Promise<PasswordEstimator> | undefined;

export async function evaluateSignupPasswordStrength(
  input: SignupPasswordStrengthInput,
): Promise<SignupPasswordStrength> {
  const score = await scoreSignupPassword(input);
  return {
    score,
    acceptable: score >= minScore,
    label: passwordStrengthLabel(score),
  };
}

export function preloadSignupPasswordStrengthEstimator(): Promise<void> {
  return loadPasswordEstimator().then(() => undefined);
}

async function scoreSignupPassword(input: SignupPasswordStrengthInput): Promise<number> {
  if (input.password.length < 12) {
    return 0;
  }
  const estimatePassword = await loadPasswordEstimator();
  return estimatePassword(input.password, [...contextualPasswordTerms(input)]).score;
}

function loadPasswordEstimator(): Promise<PasswordEstimator> {
  passwordEstimatorPromise ??= import("zxcvbn").then(
    (module) => (module as unknown as PasswordEstimatorModule).default,
  );
  return passwordEstimatorPromise;
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
import type estimatePassword from "zxcvbn";
