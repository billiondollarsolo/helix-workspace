import type { JsonObject } from "@helix/sdk-types";
import type { IngestDmarcReportInput, MailDmarcReportRowRecord } from "./admin-store.js";

/**
 * Aggregate (RUA) DMARC report parsing.
 *
 * Aggregate reports are XML documents (`<feedback>` root) emailed by receiving
 * mail providers. {@link parseDmarcAggregateReport} extracts the report
 * metadata, published policy, and per-source-IP record rows into the shape the
 * {@link MailDmarcReportStore} ingests. The parser is dependency-free — it does
 * a small, well-formed-subset scan rather than pulling a full XML library —
 * because DMARC aggregate XML is shallow and rigidly structured.
 */

/** Raised when a DMARC report XML payload cannot be parsed. */
export class DmarcReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DmarcReportParseError";
  }
}

/**
 * Parse an aggregate DMARC report XML document for one org.
 *
 * @throws {DmarcReportParseError} when the payload is missing required fields.
 */
export function parseDmarcAggregateReport(orgId: string, xml: string): IngestDmarcReportInput {
  const feedback = extractBlock(xml, "feedback");
  if (feedback === null) {
    throw new DmarcReportParseError("DMARC report is missing the <feedback> root element.");
  }

  const metadata = extractBlock(feedback, "report_metadata") ?? "";
  const policy = extractBlock(feedback, "policy_published") ?? "";

  const orgName = tagText(metadata, "org_name") ?? "";
  const reportId = tagText(metadata, "report_id");
  if (reportId === null) {
    throw new DmarcReportParseError("DMARC report is missing <report_id>.");
  }
  const dateRange = extractBlock(metadata, "date_range") ?? "";
  const begin = parseEpoch(tagText(dateRange, "begin"));
  const end = parseEpoch(tagText(dateRange, "end"));
  if (begin === null || end === null) {
    throw new DmarcReportParseError("DMARC report has an invalid <date_range>.");
  }

  const domain = tagText(policy, "domain");
  if (domain === null) {
    throw new DmarcReportParseError("DMARC report is missing the published policy <domain>.");
  }
  const policyP = tagText(policy, "p") ?? "none";
  const policySp = tagText(policy, "sp");
  const policyPct = parseIntOrNull(tagText(policy, "pct"));

  const records: MailDmarcReportRowRecord[] = [];
  for (const recordBlock of extractAllBlocks(feedback, "record")) {
    const row = extractBlock(recordBlock, "row") ?? "";
    const policyEvaluated = extractBlock(row, "policy_evaluated") ?? "";
    const identifiers = extractBlock(recordBlock, "identifiers") ?? "";
    records.push({
      sourceIp: tagText(row, "source_ip") ?? "0.0.0.0",
      messageCount: parseIntOrNull(tagText(row, "count")) ?? 0,
      disposition: tagText(policyEvaluated, "disposition") ?? "none",
      dkimResult: tagText(policyEvaluated, "dkim") ?? "fail",
      spfResult: tagText(policyEvaluated, "spf") ?? "fail",
      headerFrom: tagText(identifiers, "header_from") ?? "",
    });
  }

  const raw: JsonObject = {
    orgName,
    reportId,
    domain,
    recordCount: records.length,
  };

  return {
    orgId,
    domain,
    orgName,
    reportId,
    dateRangeBegin: begin,
    dateRangeEnd: end,
    policyP,
    policySp,
    policyPct,
    records,
    raw,
  };
}

/** Extract the inner content of the first `<tag>...</tag>` block. */
function extractBlock(source: string, tag: string): string | null {
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "iu");
  const openMatch = open.test(source) ? open.exec(source) : null;
  if (openMatch === null) {
    return null;
  }
  const start = openMatch.index + openMatch[0].length;
  const closeIndex = source.indexOf(`</${tag}>`, start);
  if (closeIndex === -1) {
    return null;
  }
  return source.slice(start, closeIndex);
}

/** Extract every `<tag>...</tag>` block's inner content. */
function extractAllBlocks(source: string, tag: string): readonly string[] {
  const blocks: string[] = [];
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "giu");
  for (const match of source.matchAll(pattern)) {
    blocks.push(match[1] ?? "");
  }
  return blocks;
}

/** Extract the text content of the first immediate `<tag>` element. */
function tagText(source: string, tag: string): string | null {
  const block = extractBlock(source, tag);
  if (block === null) {
    return null;
  }
  const text = block.replace(/<[^>]*>/gu, "").trim();
  return text.length === 0 ? null : decodeXmlEntities(text);
}

function parseEpoch(value: string | null): Date | null {
  if (value === null) {
    return null;
  }
  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(seconds * 1000);
}

function parseIntOrNull(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}
