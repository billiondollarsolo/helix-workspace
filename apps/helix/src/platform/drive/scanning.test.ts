import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createClamAvVirusScanner,
  createNoopVirusScanner,
  assertDriveMalwareScannerReady,
  resolveEffectiveMime,
  sniffMimeType,
} from "./scanning.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = Buffer.from("%PDF-1.7\n% helix", "utf8");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const servers: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function fakeClamd(reply: string): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
      socket.resume();
      socket.once("end", () => socket.end(reply));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Failed to bind fake clamd."));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

describe("sniffMimeType", () => {
  it("detects PNG, PDF, JPEG, and ZIP by magic bytes", () => {
    expect(sniffMimeType(PNG)).toBe("image/png");
    expect(sniffMimeType(PDF)).toBe("application/pdf");
    expect(sniffMimeType(JPEG)).toBe("image/jpeg");
    expect(sniffMimeType(ZIP)).toBe("application/zip");
  });

  it("returns null for unrecognized bytes", () => {
    expect(sniffMimeType(Buffer.from("just text"))).toBeNull();
  });

  it("detects SVG heuristically", () => {
    expect(sniffMimeType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(
      "image/svg+xml",
    );
  });
});

describe("resolveEffectiveMime", () => {
  it("overrides a client mime that lies about content type", () => {
    expect(resolveEffectiveMime("image/png", "application/pdf")).toBe("application/pdf");
  });

  it("keeps the client mime when the sniff is inconclusive", () => {
    expect(resolveEffectiveMime("text/csv", null)).toBe("text/csv");
  });

  it("keeps OOXML client mime when sniff only sees zip", () => {
    expect(
      resolveEffectiveMime(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/zip",
      ),
    ).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });
});

describe("createNoopVirusScanner", () => {
  it("reports clean", async () => {
    expect(await createNoopVirusScanner().scan(PNG)).toEqual({ clean: true });
  });

  it("is rejected for Business production boot", () => {
    expect(() => {
      assertDriveMalwareScannerReady("business", createNoopVirusScanner());
    }).toThrow("Business Drive requires the real streaming ClamAV adapter");
    expect(() => {
      assertDriveMalwareScannerReady("personal", createNoopVirusScanner());
    }).not.toThrow();
  });
});

describe("createClamAvVirusScanner", () => {
  it("maps a real clean clamd verdict into the Drive adapter", async () => {
    const daemon = await fakeClamd("stream: OK\0");
    servers.push(daemon);
    const scanner = createClamAvVirusScanner({
      host: "127.0.0.1",
      port: daemon.port,
      tier: "business",
      scannerVersion: "1.4.3/27388",
    });

    const result = await scanner.scan(PNG);

    expect(result).toMatchObject({
      clean: true,
      disposition: "allow",
      securityScan: {
        state: "clean",
        evidence: {
          scannerName: "clamav",
          scannerVersion: "1.4.3/27388",
          byteSize: PNG.byteLength,
        },
      },
    });
  });

  it("maps an infected signature and quarantines at every tier", async () => {
    const daemon = await fakeClamd("stream: Eicar-Test-Signature FOUND\0");
    servers.push(daemon);
    const scanner = createClamAvVirusScanner({
      host: "127.0.0.1",
      port: daemon.port,
      tier: "personal",
    });

    const result = await scanner.scan(Buffer.from("infected"));

    expect(result).toMatchObject({
      clean: false,
      signature: "Eicar-Test-Signature",
      disposition: "quarantine",
      securityScan: { state: "infected" },
    });
  });

  it("fails closed on Business scanner errors", async () => {
    const daemon = await fakeClamd("INSTREAM read error. ERROR\0");
    servers.push(daemon);
    const scanner = createClamAvVirusScanner({
      host: "127.0.0.1",
      port: daemon.port,
      tier: "business",
    });

    const result = await scanner.scan(PDF);

    expect(result).toMatchObject({
      clean: false,
      disposition: "quarantine",
      securityScan: { state: "scan_failed" },
    });
  });

  it("marks Personal scanner errors as explicitly unscanned", async () => {
    const daemon = await fakeClamd("INSTREAM read error. ERROR\0");
    servers.push(daemon);
    const scanner = createClamAvVirusScanner({
      host: "127.0.0.1",
      port: daemon.port,
      tier: "personal",
    });

    const result = await scanner.scan(PDF);

    expect(result).toMatchObject({
      clean: false,
      disposition: "allow_unscanned",
      securityScan: { state: "scan_failed" },
    });
  });
});
