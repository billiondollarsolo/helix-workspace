import { describe, expect, it } from "vitest";
import {
  DavStandardsParseError,
  davElements,
  davText,
  decodePathSegment,
  parseDavXml,
  parseICalendar,
  parseVCard,
} from "./standards.js";

describe("bounded DAV standards parsers", () => {
  it("parses namespaced XML by local name and rejects malformed/entity documents", () => {
    const root = parseDavXml(
      '<D:sync-collection xmlns:D="DAV:"><D:sync-token>data:,a&amp;b</D:sync-token></D:sync-collection>',
    );
    expect(root.name).toBe("sync-collection");
    expect(davText(davElements(root, "sync-token")[0])).toBe("data:,a&b");
    expect(() => parseDavXml("<D:x><D:y></D:x>")).toThrow(DavStandardsParseError);
    expect(() => parseDavXml('<!DOCTYPE x [<!ENTITY x "boom">]><x>&x;</x>')).toThrow(
      DavStandardsParseError,
    );
    expect(() => parseDavXml(`${"<x>".repeat(40)}${"</x>".repeat(40)}`)).toThrow(
      expect.objectContaining({ reason: "invalid" }),
    );
  });

  it("uses ICAL.js for folded/parameterized iCalendar and vCard content", () => {
    const calendar = parseICalendar(
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:event-1\r\nSUMMARY:Folded \r\n value\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    );
    expect(calendar.getFirstSubcomponent("vevent")?.getFirstPropertyValue("summary")).toBe(
      "Folded value",
    );
    const card = parseVCard(
      'BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Doe\\, Jane\r\nEMAIL;TYPE="work,home":jane@example.com\r\nEND:VCARD\r\n',
    );
    expect(card.getFirstPropertyValue("fn")).toBe("Doe, Jane");
  });

  it("maps malformed percent encoding and bounded inputs to shared errors", () => {
    expect(() => decodePathSegment("bad%zz.vcf")).toThrow(DavStandardsParseError);
    expect(() => parseVCard(`BEGIN:VCARD\r\n${"X".repeat(512 * 1024)}\r\nEND:VCARD`)).toThrow(
      expect.objectContaining({ reason: "too_large" }),
    );
  });

  it("fuzzes malformed delimiters without leaking parser exceptions", () => {
    for (const input of ["<", "<x>", "<x><y/></z>", "\0<x/>", "BEGIN:VCARD\r\nEND:VCALENDAR"]) {
      expect(() => (input.startsWith("BEGIN") ? parseVCard(input) : parseDavXml(input))).toThrow(
        DavStandardsParseError,
      );
    }
  });
});
