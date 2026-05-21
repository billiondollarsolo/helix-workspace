import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ImmutableAuditActivityRecord } from "./immutable-s3.js";
import {
  cefSeverityFor,
  formatAuditCef,
  formatAuditLeef,
  formatAuditRecord,
} from "./siem-format.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(
  overrides: Partial<ImmutableAuditActivityRecord> = {},
): ImmutableAuditActivityRecord {
  return {
    id: "rec-1",
    orgId: "org-1",
    actorId: "actor-1",
    verb: "document.created",
    objectType: "document",
    objectId: "doc-1",
    createdAt: "2026-05-21T12:00:00.000Z",
    metadata: {},
    thisHash: digest("rec-1"),
    prevHash: digest("rec-0"),
    trace: { traceId: "trace-1", spanId: "span-1" },
    ...overrides,
  };
}

describe("CEF audit formatting", () => {
  it("emits the CEF header and sorted key=value extension list", () => {
    const cef = formatAuditCef(record());
    const [header, extension] = splitOnce(cef, "|extension|") ?? cefParts(cef);

    expect(header).toBe("CEF:0|Helix|HelixPlatform|1.0|document|document.created|5");
    expect(extension).toContain(`helixRecordId=rec-1`);
    expect(extension).toContain(`helixThisHash=${digest("rec-1")}`);
    expect(extension).toContain(`helixPrevHash=${digest("rec-0")}`);
    expect(extension).toContain("suser=actor-1");
    expect(extension).toContain("helixTraceId=trace-1");
    // Extension keys are emitted in sorted order.
    const keys = extension.split(" ").map((pair) => pair.split("=")[0]);
    expect(keys).toEqual([...keys].sort());
  });

  it("escapes pipes in the CEF header and equals signs in extensions", () => {
    const cef = formatAuditCef(
      record({ verb: "weird|verb", objectType: "ty=pe", metadata: {} }),
    );
    expect(cef).toContain("weird\\|verb");
  });

  it("maps verbs to coarse CEF severities", () => {
    expect(cefSeverityFor("document.deleted")).toBe(8);
    expect(cefSeverityFor("credential.rotated")).toBe(7);
    expect(cefSeverityFor("document.created")).toBe(5);
    expect(cefSeverityFor("document.viewed")).toBe(3);
  });
});

describe("LEEF audit formatting", () => {
  it("emits the LEEF 2.0 header with a tab delimiter declaration", () => {
    const leef = formatAuditLeef(record());
    expect(leef.startsWith("LEEF:2.0|Helix|HelixPlatform|1.0|document.created|x09|")).toBe(true);

    const attributes = leef.slice(leef.indexOf("x09|") + 4);
    const pairs = attributes.split("\t");
    expect(pairs).toContain(`helixThisHash=${digest("rec-1")}`);
    expect(pairs).toContain("helixObjectId=doc-1");
    expect(pairs).toContain("suser=actor-1");
  });

  it("dispatches by format via formatAuditRecord", () => {
    const rec = record();
    expect(formatAuditRecord("cef", rec)).toBe(formatAuditCef(rec));
    expect(formatAuditRecord("leef", rec)).toBe(formatAuditLeef(rec));
  });
});

function cefParts(cef: string): [string, string] {
  const idx = nthPipe(cef, 7);
  return [cef.slice(0, idx), cef.slice(idx + 1)];
}

function nthPipe(value: string, n: number): number {
  let count = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "|" && value[i - 1] !== "\\") {
      count += 1;
      if (count === n) {
        return i;
      }
    }
  }
  return -1;
}

function splitOnce(value: string, sep: string): [string, string] | null {
  const idx = value.indexOf(sep);
  return idx === -1 ? null : [value.slice(0, idx), value.slice(idx + sep.length)];
}
