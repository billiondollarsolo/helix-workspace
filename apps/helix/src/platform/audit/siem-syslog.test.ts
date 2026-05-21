import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ImmutableAuditActivityRecord } from "./immutable-s3.js";
import {
  SiemAuditShipper,
  buildSyslogMessage,
  frameOctetCounting,
  type SiemSyslogTransportClient,
} from "./siem-syslog.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(
  id: string,
  overrides: Partial<ImmutableAuditActivityRecord> = {},
): ImmutableAuditActivityRecord {
  return {
    id,
    orgId: "org-1",
    actorId: "actor-1",
    verb: "document.created",
    objectType: "document",
    objectId: "doc-1",
    createdAt: "2026-05-21T12:00:00.000Z",
    metadata: {},
    thisHash: digest(id),
    ...overrides,
  };
}

class RecordingTransport implements SiemSyslogTransportClient {
  readonly sent: Buffer[] = [];
  closed = false;

  async send(payload: Buffer): Promise<void> {
    this.sent.push(payload);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const fixedNow = (): Date => new Date("2026-05-21T12:00:00.000Z");

describe("buildSyslogMessage", () => {
  it("produces an RFC 5424 message with priority, structured data and CEF body", () => {
    const message = buildSyslogMessage(record("rec-1"), {
      format: "cef",
      facility: 13,
      severity: 6,
      appName: "helix-audit",
      hostname: "helix-1",
      timestamp: fixedNow(),
    });

    // PRIVAL = facility*8 + severity = 13*8 + 6 = 110, VERSION = 1.
    expect(message.startsWith("<110>1 2026-05-21T12:00:00.000Z helix-1 helix-audit - ")).toBe(
      true,
    );
    expect(message).toContain('[helix@32473 recordId="rec-1"');
    expect(message).toContain(`thisHash="${digest("rec-1")}"`);
    expect(message).toContain("CEF:0|Helix|HelixPlatform|1.0|document|document.created|5");
  });
});

describe("frameOctetCounting", () => {
  it("prefixes the byte length and a space (RFC 6587)", () => {
    const framed = frameOctetCounting("hello").toString("utf8");
    expect(framed).toBe("5 hello");
  });

  it("counts UTF-8 bytes, not characters", () => {
    const framed = frameOctetCounting("é").toString("utf8");
    expect(framed).toBe("2 é");
  });
});

describe("SiemAuditShipper", () => {
  it("ships each record as an octet-counted CEF syslog frame over TCP", async () => {
    const transport = new RecordingTransport();
    const shipper = new SiemAuditShipper({
      host: "siem.example.com",
      port: 6514,
      transport: "tcp",
      format: "cef",
      now: fixedNow,
      transportFactory: () => transport,
    });

    const result = await shipper.ship([record("rec-1"), record("rec-2")]);

    expect(transport.sent).toHaveLength(2);
    expect(transport.closed).toBe(true);
    const first = transport.sent[0]?.toString("utf8") ?? "";
    expect(first).toMatch(/^\d+ <110>1 /);
    expect(first).toContain("CEF:0|");
    expect(result).toMatchObject({
      recordCount: 2,
      recordsKey: "siem://siem.example.com:6514",
      recordsSha256: digest("rec-2"),
    });
  });

  it("ships LEEF datagrams without octet-counting framing over UDP", async () => {
    const transport = new RecordingTransport();
    const shipper = new SiemAuditShipper({
      host: "siem.example.com",
      port: 514,
      transport: "udp",
      format: "leef",
      now: fixedNow,
      transportFactory: () => transport,
    });

    await shipper.ship([record("rec-1")]);

    const payload = transport.sent[0]?.toString("utf8") ?? "";
    // UDP payloads are raw RFC 5424 messages — no leading "<len> ".
    expect(payload.startsWith("<110>1 ")).toBe(true);
    expect(payload).toContain("LEEF:2.0|Helix|HelixPlatform|1.0|document.created|x09|");
  });

  it("rejects an empty batch", async () => {
    const shipper = new SiemAuditShipper({
      host: "siem.example.com",
      port: 6514,
      transport: "tcp",
      format: "cef",
      transportFactory: () => new RecordingTransport(),
    });
    await expect(shipper.ship([])).rejects.toThrow("at least one record");
  });

  it("validates the port and severity ranges", () => {
    expect(
      () =>
        new SiemAuditShipper({ host: "h", port: 70_000, transport: "tcp", format: "cef" }),
    ).toThrow("port");
    expect(
      () =>
        new SiemAuditShipper({
          host: "h",
          port: 6514,
          transport: "tcp",
          format: "cef",
          severity: 99,
        }),
    ).toThrow("severity");
  });
});
