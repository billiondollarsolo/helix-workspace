import { randomUUID } from "node:crypto";
import type { MailOutboundEnvelope } from "./types.js";

const MAX_MESSAGE_ID_HEADER_LENGTH = 998;
const MAX_THREAD_REFERENCES = 100;
const ANGLE_MESSAGE_ID = /<([^<>]+)>/gu;

/** Canonical RFC Message-ID form. The local part is case-sensitive; the domain is not. */
export function normalizeMessageId(value: string | undefined): string | null {
  const ids = normalizeMessageIds(value);
  return ids.length === 1 ? (ids[0] ?? null) : null;
}

/** Extract, canonicalize, bound, and de-duplicate IDs from RFC reference fields. */
export function normalizeMessageIds(
  values: string | readonly string[] | undefined,
): readonly string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of typeof values === "string" ? [values] : (values ?? [])) {
    if (value.length === 0 || value.length > MAX_MESSAGE_ID_HEADER_LENGTH) {
      continue;
    }
    const matches = [...value.matchAll(ANGLE_MESSAGE_ID)];
    const candidates =
      matches.length === 0
        ? [value.trim()]
        : matches.flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
    for (const candidate of candidates) {
      const id = canonicalizeMessageId(candidate);
      if (id === null || seen.has(id)) {
        continue;
      }
      seen.add(id);
      normalized.push(id);
      if (normalized.length === MAX_THREAD_REFERENCES) {
        return normalized;
      }
    }
  }
  return normalized;
}

/** Parent first, then nearest-to-oldest References, with deterministic de-duplication. */
export function threadReferenceIds(input: {
  readonly inReplyTo?: string | undefined;
  readonly references?: readonly string[] | undefined;
}): readonly string[] {
  const parentIds = normalizeMessageIds(input.inReplyTo);
  const ancestry = [...normalizeMessageIds(input.references)].reverse();
  return [...new Set([...parentIds, ...ancestry])];
}

/** Prepare the immutable RFC threading headers persisted with an outbound queue record. */
export function prepareOutboundEnvelope(envelope: MailOutboundEnvelope): MailOutboundEnvelope {
  const messageId =
    envelope.messageId === undefined
      ? `<${randomUUID()}@${messageIdDomain(envelope.from.address)}>`
      : requireSingleMessageId(envelope.messageId, "Message-ID");
  const inReplyTo =
    envelope.inReplyTo === undefined
      ? undefined
      : requireSingleMessageId(envelope.inReplyTo, "In-Reply-To");
  const references = normalizeMessageIds(envelope.references);
  if ((envelope.references?.length ?? 0) > 0 && references.length === 0) {
    throw new TypeError("References must contain at least one valid Message-ID.");
  }
  return {
    ...envelope,
    messageId,
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    ...(references.length === 0 ? {} : { references }),
  };
}

export function normalizeProviderDeliveryId(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 512 && !hasControlCharacter(normalized)
    ? normalized
    : null;
}

function canonicalizeMessageId(value: string): string | null {
  const candidate = value.trim();
  const separator = candidate.lastIndexOf("@");
  if (
    candidate.length === 0 ||
    candidate.length > MAX_MESSAGE_ID_HEADER_LENGTH ||
    hasInvalidMessageIdCharacter(candidate) ||
    separator <= 0 ||
    separator === candidate.length - 1 ||
    candidate.indexOf("@") !== separator
  ) {
    return null;
  }
  return `<${candidate.slice(0, separator)}@${candidate.slice(separator + 1).toLowerCase()}>`;
}

function requireSingleMessageId(value: string, header: string): string {
  const normalized = normalizeMessageId(value);
  if (normalized === null) {
    throw new TypeError(`${header} must contain exactly one valid Message-ID.`);
  }
  return normalized;
}

function messageIdDomain(address: string): string {
  const separator = address.lastIndexOf("@");
  const domain =
    separator < 1
      ? ""
      : address
          .slice(separator + 1)
          .trim()
          .toLowerCase();
  return domain.length === 0 || hasInvalidMessageIdCharacter(domain) ? "helix.local" : domain;
}

function hasInvalidMessageIdCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 32 || code === 60 || code === 62 || code === 127) {
      return true;
    }
  }
  return false;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}
