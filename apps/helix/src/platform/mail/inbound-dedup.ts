import { createHash } from "node:crypto";
import { normalizeMailboxAddress } from "./address-normalization.js";
import type { MailInboundDedupInput } from "./store.js";

const MESSAGE_ID = /^<([^<>\s@]+)@([^<>\s@]+)>$/u;

export function createInboundDeliveryDedup(input: {
  readonly orgId: string;
  readonly raw: Buffer | string;
  readonly messageId?: string | undefined;
  readonly envelopeFrom?: string | undefined;
  readonly envelopeTo: readonly string[];
  readonly receivedAt: Date;
}): MailInboundDedupInput {
  const rawBytes = Buffer.isBuffer(input.raw) ? input.raw : Buffer.from(input.raw);
  const rawSha256 = createHash("sha256").update(rawBytes).digest("hex");
  const normalizedMessageId = normalizeInboundMessageId(input.messageId);
  const envelopeFrom =
    input.envelopeFrom === undefined || input.envelopeFrom.length === 0
      ? null
      : normalizeMailboxAddress(input.envelopeFrom).address;
  const envelopeTo = [
    ...new Set(input.envelopeTo.map((address) => normalizeMailboxAddress(address).address)),
  ].sort();
  if (envelopeTo.length === 0) {
    throw new TypeError("Inbound dedup requires at least one envelope recipient.");
  }
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        "helix-inbound-v1",
        input.orgId,
        normalizedMessageId,
        envelopeFrom,
        envelopeTo,
        rawSha256,
      ]),
      "utf8",
    )
    .digest("hex");
  return {
    key,
    normalizedMessageId,
    rawSha256,
    envelopeFrom,
    envelopeTo,
    receivedAt: input.receivedAt,
  };
}

export function normalizeInboundMessageId(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || Buffer.byteLength(trimmed, "utf8") > 998) {
    return null;
  }
  const match = MESSAGE_ID.exec(trimmed);
  if (match === null) {
    return null;
  }
  return `<${match[1]?.toLowerCase() ?? ""}@${match[2]?.toLowerCase() ?? ""}>`;
}
