import { performance } from "node:perf_hooks";
import { XMLParser } from "fast-xml-parser";
import ICAL from "ical.js";
import { DAV_BODY_LIMIT_BYTES } from "../../api/request-body.js";

const MAX_PARSE_MS = 250;
const MAX_XML_DEPTH = 32;
const MAX_NODES = 4_096;

export class DavStandardsParseError extends Error {
  constructor(
    readonly format: "xml" | "ical" | "vcard",
    readonly reason: "invalid" | "too_large" | "too_complex" | "timeout",
  ) {
    super(`Invalid or unsupported ${format} document (${reason}).`);
    this.name = "DavStandardsParseError";
  }
}

export interface DavXmlNode {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly DavXmlNode[];
  readonly text: string;
}

const xmlParser = new XMLParser({
  preserveOrder: true,
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  ignoreDeclaration: true,
  maxNestedTags: MAX_XML_DEPTH,
});

export function parseDavXml(input: string): DavXmlNode {
  const started = performance.now();
  assertBounded(input, "xml");
  if (/<!DOCTYPE|<!ENTITY/iu.test(input)) throw new DavStandardsParseError("xml", "invalid");
  try {
    const parsed: unknown = xmlParser.parse(input, true);
    const roots = xmlNodes(parsed, { count: 0 });
    if (roots.length !== 1) throw new DavStandardsParseError("xml", "invalid");
    assertTimely(started, "xml");
    return roots[0] as DavXmlNode;
  } catch (error) {
    if (error instanceof DavStandardsParseError) throw error;
    throw new DavStandardsParseError("xml", "invalid");
  }
}

export function davElements(root: DavXmlNode, name: string): readonly DavXmlNode[] {
  const output: DavXmlNode[] = [];
  const visit = (node: DavXmlNode) => {
    if (node.name.toLowerCase() === name.toLowerCase()) output.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return output;
}

export function davText(node: DavXmlNode | undefined): string {
  if (node === undefined) return "";
  return decodeXmlText(`${node.text}${node.children.map(davText).join("")}`);
}

export function parseICalendar(input: string): InstanceType<typeof ICAL.Component> {
  return parseContentLineDocument(input, "ical", "vcalendar");
}

export function parseVCard(input: string): InstanceType<typeof ICAL.Component> {
  return parseContentLineDocument(input, "vcard", "vcard");
}

export function decodePathSegment(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    throw new DavStandardsParseError("xml", "invalid");
  }
}

function parseContentLineDocument(
  input: string,
  format: "ical" | "vcard",
  expectedRoot: string,
): InstanceType<typeof ICAL.Component> {
  const started = performance.now();
  assertBounded(input, format);
  const lines = input.trim().split(/\r\n|\r|\n/u);
  const boundary = expectedRoot.toUpperCase();
  if (lines.length > MAX_NODES) throw new DavStandardsParseError(format, "too_complex");
  if (
    lines[0]?.toUpperCase() !== `BEGIN:${boundary}` ||
    lines.at(-1)?.toUpperCase() !== `END:${boundary}`
  )
    throw new DavStandardsParseError(format, "invalid");
  try {
    const parsed = ICAL.parse(input) as unknown;
    if (!Array.isArray(parsed)) throw new DavStandardsParseError(format, "invalid");
    const component = new ICAL.Component(parsed);
    if (component.name !== expectedRoot) throw new DavStandardsParseError(format, "invalid");
    const count = countComponents(component);
    if (count > MAX_NODES) throw new DavStandardsParseError(format, "too_complex");
    assertTimely(started, format);
    return component;
  } catch (error) {
    if (error instanceof DavStandardsParseError) throw error;
    throw new DavStandardsParseError(format, "invalid");
  }
}

function assertBounded(input: string, format: "xml" | "ical" | "vcard") {
  if (Buffer.byteLength(input) > DAV_BODY_LIMIT_BYTES) {
    throw new DavStandardsParseError(format, "too_large");
  }
}

function assertTimely(started: number, format: "xml" | "ical" | "vcard") {
  if (performance.now() - started > MAX_PARSE_MS) {
    throw new DavStandardsParseError(format, "timeout");
  }
}

function countComponents(component: InstanceType<typeof ICAL.Component>): number {
  let count = 1 + component.getAllProperties().length;
  for (const child of component.getAllSubcomponents()) count += countComponents(child);
  return count;
}

function xmlNodes(value: unknown, state: { count: number }): readonly DavXmlNode[] {
  if (!Array.isArray(value)) return [];
  const output: DavXmlNode[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const attributes = stringRecord(record[":@"]);
    for (const [name, childValue] of Object.entries(record)) {
      if (name === ":@" || name === "#text") continue;
      state.count += 1;
      if (state.count > MAX_NODES) throw new DavStandardsParseError("xml", "too_complex");
      const childEntries = Array.isArray(childValue) ? childValue : [];
      const text = childEntries.flatMap(textEntry).join("");
      output.push({ name, attributes, children: xmlNodes(childEntries, state), text });
    }
  }
  return output;
}

function textEntry(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null) return [];
  const text = (value as Record<string, unknown>)["#text"];
  return typeof text === "string" ? [text] : [];
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) => codePoint(hex, 16))
    .replace(/&#([0-9]+);/gu, (_match, decimal: string) => codePoint(decimal, 10))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function codePoint(value: string, radix: number): string {
  const parsed = Number.parseInt(value, radix);
  return Number.isSafeInteger(parsed) && parsed <= 0x10ffff
    ? String.fromCodePoint(parsed)
    : "\ufffd";
}
