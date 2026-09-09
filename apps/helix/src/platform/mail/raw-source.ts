import { createHash } from "node:crypto";
import { simpleParser, type ParsedMail } from "mailparser";
import type { JsonObject, JsonValue } from "@helix/sdk-types";
import { MailRawSourceIntegrityError } from "./errors.js";
import type { MailRawSourceInput } from "./types.js";

/** Keep this in lockstep with the pinned mailparser dependency. */
export const MAIL_RAW_PARSER = "mailparser@3.9.20";
export const MAIL_RAW_PROJECTION_VERSION = 1;
export const MAIL_RAW_SOURCE_MAX_BYTES = 50 * 1024 * 1024;

/** Copy and describe the exact input bytes; parsed content is only a disposable projection. */
export function prepareMailRawSource(raw: Buffer | string, parsed: ParsedMail): MailRawSourceInput {
  const bytes = Buffer.from(raw);
  if (bytes.byteLength > MAIL_RAW_SOURCE_MAX_BYTES) {
    throw new RangeError("Raw mail source exceeds the 50 MiB evidence limit.");
  }
  const projection = projectParsedMail(parsed);
  return {
    bytes,
    byteSize: bytes.byteLength,
    sha256: sha256(bytes),
    parser: MAIL_RAW_PARSER,
    projectionVersion: MAIL_RAW_PROJECTION_VERSION,
    projection,
    projectionSha256: sha256(canonicalJson(projection)),
  };
}

/**
 * Verify both immutable bytes and the persisted parse result before exporting evidence.
 * Unknown parser/projection versions fail closed instead of silently changing semantics.
 */
export async function verifyMailRawSource(source: MailRawSourceInput): Promise<void> {
  if (
    source.parser !== MAIL_RAW_PARSER ||
    source.projectionVersion !== MAIL_RAW_PROJECTION_VERSION ||
    source.bytes.byteLength !== source.byteSize ||
    sha256(source.bytes) !== source.sha256 ||
    sha256(canonicalJson(source.projection)) !== source.projectionSha256
  ) {
    throw new MailRawSourceIntegrityError();
  }
  const reparsed = projectParsedMail(await simpleParser(source.bytes));
  if (sha256(canonicalJson(reparsed)) !== source.projectionSha256) {
    throw new MailRawSourceIntegrityError();
  }
}

/** Safe structural projection: no raw header values, body HTML, or attachment bytes. */
export function projectParsedMail(parsed: ParsedMail): JsonObject {
  const amp = (parsed as ParsedMail & { readonly amp?: string }).amp;
  return {
    parser: MAIL_RAW_PARSER,
    version: MAIL_RAW_PROJECTION_VERSION,
    headers: projectHeaders(parsed.headerLines),
    bodies: {
      text: projectText(parsed.text),
      html: projectText(parsed.html === false ? undefined : parsed.html),
      textAsHtml: projectText(parsed.textAsHtml),
      amp: projectText(amp),
    },
    attachments: parsed.attachments.map((attachment) => ({
      contentType:
        (attachment as { readonly contentType?: string }).contentType ?? "application/octet-stream",
      disposition:
        (attachment as { readonly contentDisposition?: string }).contentDisposition ?? "attachment",
      filename: attachment.filename ?? null,
      contentId: attachment.contentId ?? null,
      cid: attachment.cid ?? null,
      related: (attachment as { readonly related?: boolean }).related ?? false,
      byteSize: attachment.content.byteLength,
      sha256: sha256(attachment.content),
      // mailparser's runtime omits headerLines for some attachment nodes even
      // though the DefinitelyTyped declaration marks it required.
      headers: projectHeaders(
        (attachment as { readonly headerLines?: typeof attachment.headerLines }).headerLines ?? [],
      ),
    })),
  };
}

function projectHeaders(
  lines: ReadonlyArray<{ readonly key: string; readonly line: string }>,
): JsonValue[] {
  return lines.map(({ key, line }) => ({
    name: key.toLowerCase(),
    byteSize: Buffer.byteLength(line),
    sha256: sha256(line),
  }));
}

function projectText(value: string | undefined): JsonObject | null {
  return value === undefined ? null : { byteSize: Buffer.byteLength(value), sha256: sha256(value) };
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
