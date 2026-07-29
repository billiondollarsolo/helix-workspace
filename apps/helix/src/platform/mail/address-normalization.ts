import { domainToASCII } from "node:url";

const ASCII_DOMAIN = /^[a-z0-9.-]+$/u;
const ASCII_DOT_ATOM = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u;

export type MailAddressNormalizationErrorCode =
  | "control_character"
  | "empty"
  | "invalid_domain"
  | "invalid_local_part"
  | "oversized";

export class MailAddressNormalizationError extends Error {
  constructor(
    readonly code: MailAddressNormalizationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MailAddressNormalizationError";
  }
}

export interface NormalizedMailboxAddress {
  readonly address: string;
  readonly localPart: string;
  readonly domain: string;
}

/**
 * Convert a Unicode domain to its lower-case IDNA ASCII form.
 *
 * The result is suitable for persistence and equality checks. A trailing root
 * dot is intentionally rejected: receiving-domain configuration is an exact
 * mail domain, not a DNS presentation name.
 */
export function normalizeMailDomain(input: string): string {
  assertStringInput(input, "domain");
  if (input.length === 0) {
    throw new MailAddressNormalizationError("empty", "Domain must not be empty.");
  }
  if (input !== input.trim()) {
    throw new MailAddressNormalizationError(
      "invalid_domain",
      "Domain must not contain surrounding whitespace.",
    );
  }

  let ascii: string;
  try {
    ascii = domainToASCII(input.normalize("NFC").toLowerCase());
  } catch {
    throw invalidDomain();
  }
  if (ascii.length === 0 || !ASCII_DOMAIN.test(ascii)) {
    throw invalidDomain();
  }
  if (Buffer.byteLength(ascii, "ascii") > 253) {
    throw new MailAddressNormalizationError("oversized", "Domain exceeds the 253-byte DNS limit.");
  }

  const labels = ascii.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 || label.length > 63 || label.startsWith("-") || label.endsWith("-"),
    )
  ) {
    throw invalidDomain();
  }
  return ascii;
}

/**
 * Normalize an SMTP mailbox address for routing.
 *
 * Helix MVP deliberately supports the interoperable ASCII dot-atom subset.
 * Local parts are case-folded because Helix mailbox identity is
 * case-insensitive; quoted strings, comments, display names, and SMTPUTF8
 * local parts are rejected at this routing boundary.
 */
export function normalizeMailboxAddress(input: string): NormalizedMailboxAddress {
  assertStringInput(input, "address");
  if (input.length === 0) {
    throw new MailAddressNormalizationError("empty", "Email address must not be empty.");
  }
  if (input !== input.trim()) {
    throw new MailAddressNormalizationError(
      "invalid_local_part",
      "Email address must not contain surrounding whitespace.",
    );
  }

  const separator = input.indexOf("@");
  if (separator <= 0 || separator !== input.lastIndexOf("@") || separator === input.length - 1) {
    throw new MailAddressNormalizationError(
      "invalid_local_part",
      "Email address must contain one local part and one domain.",
    );
  }

  const rawLocalPart = input.slice(0, separator);
  const localPart = rawLocalPart.toLowerCase();
  if (
    !ASCII_DOT_ATOM.test(localPart) ||
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..")
  ) {
    throw new MailAddressNormalizationError(
      "invalid_local_part",
      "Email local part is not a supported ASCII dot-atom.",
    );
  }
  if (Buffer.byteLength(localPart, "ascii") > 64) {
    throw new MailAddressNormalizationError(
      "oversized",
      "Email local part exceeds the 64-byte SMTP limit.",
    );
  }

  const domain = normalizeMailDomain(input.slice(separator + 1));
  const address = `${localPart}@${domain}`;
  if (Buffer.byteLength(address, "ascii") > 254) {
    throw new MailAddressNormalizationError(
      "oversized",
      "Email address exceeds the 254-byte SMTP limit.",
    );
  }
  return { address, localPart, domain };
}

function assertStringInput(input: string, kind: string): void {
  for (const character of input) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      throw new MailAddressNormalizationError(
        "control_character",
        `Mail ${kind} must not contain control characters.`,
      );
    }
  }
}

function invalidDomain(): MailAddressNormalizationError {
  return new MailAddressNormalizationError(
    "invalid_domain",
    "Domain is not a valid IDNA DNS name.",
  );
}
