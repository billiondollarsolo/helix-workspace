export type DlpDetector = "pii" | "credentials" | "credit_card" | "source_code";
export interface DlpFinding {
  readonly detector: DlpDetector | "classification" | "scan_limit";
  readonly classification: "confidential" | "restricted";
}

export function detectDlp(text: string, enabled: ReadonlySet<DlpDetector>): DlpFinding[] {
  const findings: DlpFinding[] = [];
  if (enabled.has("pii") && /\b\d{3}-\d{2}-\d{4}\b/u.test(text)) {
    findings.push({ detector: "pii", classification: "confidential" });
  }
  if (
    enabled.has("credentials") &&
    /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(?:api[_-]?key|secret)[ \t]*[:=][ \t]*[A-Za-z0-9_-]{12,})/iu.test(
      text,
    )
  ) {
    findings.push({ detector: "credentials", classification: "restricted" });
  }
  if (enabled.has("credit_card") && paymentCardNumbers(text).some(luhnValid)) {
    findings.push({ detector: "credit_card", classification: "confidential" });
  }
  if (
    enabled.has("source_code") &&
    /(?:\b(?:class|function|interface)\s+[A-Za-z_$][\w$]*\b|\b(?:SELECT|INSERT|UPDATE|DELETE)\s+.+\s+FROM\b)/iu.test(
      text,
    )
  ) {
    findings.push({ detector: "source_code", classification: "confidential" });
  }
  return findings;
}

// PAN candidates use continuous digits or conventional groups; date/day series are not cards.
// Whitespace may separate a PAN from an amount/year; retain detection in ambiguous numeric prose.
function paymentCardNumbers(text: string): string[] {
  return [
    ...text.matchAll(
      /(?<!\d[ \t]*-[ \t-]*)\b(?:\d{13,19}|\d{4}(?:[ \t-]+\d{4}){3}[ \t-]+\d{3}|\d{4}[ \t-]+\d{6}[ \t-]+\d{4,5}|\d{4}(?:[ \t-]+\d{4}){2}[ \t-]+\d{1,4})\b(?![ \t]*-[ \t-]*\d)/gu,
    ),
  ]
    .map((match) => match[0].replace(/[^0-9]/gu, ""))
    .filter((value) => value.length >= 13 && value.length <= 19);
}

function luhnValid(value: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}
