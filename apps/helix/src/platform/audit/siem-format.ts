import type { ImmutableAuditActivityRecord } from "./immutable-s3.js";

/**
 * CEF / LEEF event formatting for the SIEM audit destination.
 *
 * - CEF (Common Event Format, ArcSight) — header pipe-delimited, then a
 *   key=value extension list. Reference: "Implementing ArcSight CEF" rev. 25.
 * - LEEF (Log Event Extended Format, IBM QRadar) — header pipe-delimited, then
 *   tab-delimited key=value attributes. Reference: "LEEF 2.0" QRadar spec.
 *
 * Both formats carry the immutable audit record's hash-chain material so a SIEM
 * search can be reconciled against the offline verifier.
 */

export type SiemAuditFormat = "cef" | "leef";

const cefVendor = "Helix";
const cefProduct = "HelixPlatform";
const cefVersion = "1.0";
const cefSpecVersion = "0";
const leefSpecVersion = "2.0";

/**
 * CEF severity is an integer 0-10. Audit verbs map onto a coarse scale: writes
 * that mutate state are moderate, deletes/security verbs are high, reads low.
 */
export function cefSeverityFor(verb: string): number {
  const normalized = verb.toLowerCase();
  if (/(delete|revoke|destroy|purge|deny)/.test(normalized)) {
    return 8;
  }
  if (/(auth|login|permission|grant|policy|credential|secret)/.test(normalized)) {
    return 7;
  }
  if (/(create|update|send|modify|invite|share)/.test(normalized)) {
    return 5;
  }
  return 3;
}

/** Escape a value for a CEF header field: `\` and `|` are escaped. */
function escapeCefHeader(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** Escape a value for a CEF extension field: `\`, `=` and newlines escaped. */
function escapeCefExtension(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/=/g, "\\=")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

/** Escape a value for a LEEF attribute (tab-delimited): tabs/newlines escaped. */
function escapeLeefValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

interface AuditExtensionFields {
  readonly [key: string]: string;
}

function extensionFields(record: ImmutableAuditActivityRecord): AuditExtensionFields {
  const fields: Record<string, string> = {
    helixOrgId: record.orgId,
    helixRecordId: record.id,
    helixVerb: record.verb,
    helixObjectType: record.objectType,
    helixThisHash: record.thisHash,
    suser: record.actorId,
    rt: String(Date.parse(record.createdAt)),
    end: record.createdAt,
  };
  const prevHash = record.prevHash ?? record.previousHash ?? null;
  if (prevHash !== null) {
    fields.helixPrevHash = prevHash;
  }
  if (record.objectId !== undefined) {
    fields.helixObjectId = record.objectId;
  }
  if (record.toolId !== undefined) {
    fields.helixToolId = record.toolId;
  }
  if (record.onBehalfOfActorId !== undefined) {
    fields.helixOnBehalfOfActorId = record.onBehalfOfActorId;
  }
  if (record.trace?.traceId !== undefined) {
    fields.helixTraceId = record.trace.traceId;
  }
  if (record.trace?.spanId !== undefined) {
    fields.helixSpanId = record.trace.spanId;
  }
  return fields;
}

/**
 * Format an audit record as a CEF message body (the part after the syslog
 * header). The CEF "name" is the verb and the device event class id is the
 * object type so QRadar/ArcSight can categorise without parsing extensions.
 */
export function formatAuditCef(record: ImmutableAuditActivityRecord): string {
  const header = [
    `CEF:${cefSpecVersion}`,
    escapeCefHeader(cefVendor),
    escapeCefHeader(cefProduct),
    escapeCefHeader(cefVersion),
    escapeCefHeader(record.objectType),
    escapeCefHeader(record.verb),
    String(cefSeverityFor(record.verb)),
  ].join("|");

  const fields = extensionFields(record);
  const extension = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${escapeCefExtension(fields[key] ?? "")}`)
    .join(" ");

  return `${header}|${extension}`;
}

/**
 * Format an audit record as a LEEF 2.0 message body. LEEF 2.0 declares the
 * attribute delimiter in the header; a literal tab (`x09`) is used here.
 */
export function formatAuditLeef(record: ImmutableAuditActivityRecord): string {
  const header = [
    `LEEF:${leefSpecVersion}`,
    cefVendor,
    cefProduct,
    cefVersion,
    record.verb,
    "x09",
  ].join("|");

  const fields = extensionFields(record);
  const attributes = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${escapeLeefValue(fields[key] ?? "")}`)
    .join("\t");

  return `${header}|${attributes}`;
}

export function formatAuditRecord(
  format: SiemAuditFormat,
  record: ImmutableAuditActivityRecord,
): string {
  return format === "cef" ? formatAuditCef(record) : formatAuditLeef(record);
}
