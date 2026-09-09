import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ClamdInstreamClient, parseClamdInstreamResponse } from "./clamd-client.js";
import type { SecurityScanningMetrics } from "./metrics.js";

interface FakeClamd {
  readonly port: number;
  readonly request: Promise<Buffer>;
  close(): Promise<void>;
}

const daemons: FakeClamd[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
});

function fakeClamd(
  reply: string | undefined,
  onSocket?: (socket: Socket) => void,
): Promise<FakeClamd> {
  return new Promise((resolve, reject) => {
    let resolveRequest: (request: Buffer) => void;
    const request = new Promise<Buffer>((done) => {
      resolveRequest = done;
    });
    const sockets = new Set<Socket>();
    const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.once("end", () => {
        resolveRequest(Buffer.concat(chunks));
        if (reply !== undefined) {
          socket.end(reply);
        }
      });
      socket.once("close", () => {
        sockets.delete(socket);
      });
      onSocket?.(socket);
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
        request,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

function decodeInstreamRequest(request: Buffer): {
  readonly body: Buffer;
  readonly frameSizes: readonly number[];
} {
  const command = Buffer.from("zINSTREAM\0", "ascii");
  expect(request.subarray(0, command.byteLength)).toEqual(command);
  const chunks: Buffer[] = [];
  const frameSizes: number[] = [];
  let offset = command.byteLength;
  while (offset + 4 <= request.byteLength) {
    const size = request.readUInt32BE(offset);
    offset += 4;
    if (size === 0) {
      expect(offset).toBe(request.byteLength);
      return { body: Buffer.concat(chunks), frameSizes };
    }
    frameSizes.push(size);
    chunks.push(request.subarray(offset, offset + size));
    offset += size;
  }
  throw new Error("Fake clamd received an unterminated INSTREAM request.");
}

class RecordingMetrics implements SecurityScanningMetrics {
  readonly scans: {
    readonly scannerName: string;
    readonly state: string;
    readonly durationSeconds: number;
    readonly byteSize: number;
  }[] = [];
  readonly availability: boolean[] = [];
  readonly quarantinedBytes: number[] = [];

  recordSecurityScan(input: (typeof this.scans)[number]): void {
    this.scans.push(input);
  }

  setSecurityScannerAvailable(input: {
    readonly scannerName: string;
    readonly available: boolean;
  }): void {
    this.availability.push(input.available);
  }

  setSecurityScanBacklog(): void {
    // Queue workers own this gauge; the low-level client does not.
  }

  recordSecurityQuarantinedBytes(input: {
    readonly scannerName: string;
    readonly byteSize: number;
  }): void {
    this.quarantinedBytes.push(input.byteSize);
  }
}

describe("parseClamdInstreamResponse", () => {
  it("parses clean and infected responses and sanitizes the signature", () => {
    expect(parseClamdInstreamResponse("stream: OK\0")).toEqual({
      infected: false,
      signature: null,
    });
    expect(parseClamdInstreamResponse("stream: Eicar-\u0007Test-Signature FOUND\0")).toEqual({
      infected: true,
      signature: "Eicar-Test-Signature",
    });
  });

  it("rejects daemon errors and unknown protocol responses", () => {
    expect(() => parseClamdInstreamResponse("INSTREAM size limit exceeded. ERROR")).toThrow(
      /rejected/u,
    );
    expect(() => parseClamdInstreamResponse("garbage")).toThrow(/unparseable/u);
  });
});

describe("ClamdInstreamClient", () => {
  it("streams bounded INSTREAM frames and returns safe clean evidence", async () => {
    const daemon = await fakeClamd("stream: OK\0");
    daemons.push(daemon);
    const times = [new Date("2026-07-28T12:00:00.000Z"), new Date("2026-07-28T12:00:01.000Z")];
    const client = new ClamdInstreamClient({
      host: "127.0.0.1",
      port: daemon.port,
      chunkSizeBytes: 4,
      scannerVersion: "1.4.3/27388",
      now: () => times.shift() ?? new Date("2026-07-28T12:00:01.000Z"),
    });
    async function* input(): AsyncIterable<Uint8Array> {
      yield Buffer.from("hello");
      yield Buffer.from(" world");
    }

    const result = await client.scan(input());
    const protocol = decodeInstreamRequest(await daemon.request);

    expect(protocol.body.toString("utf8")).toBe("hello world");
    expect(protocol.frameSizes).toEqual([4, 1, 4, 2]);
    expect(result).toEqual({
      state: "clean",
      evidence: {
        scannerName: "clamav",
        scannerVersion: "1.4.3/27388",
        startedAt: "2026-07-28T12:00:00.000Z",
        completedAt: "2026-07-28T12:00:01.000Z",
        byteSize: 11,
      },
    });
  });

  it("returns infected evidence without retaining submitted content", async () => {
    const daemon = await fakeClamd("stream: Win.Test.EICAR_HDB-1 FOUND\0");
    daemons.push(daemon);
    const client = new ClamdInstreamClient({
      host: "127.0.0.1",
      port: daemon.port,
    });

    const result = await client.scan(Buffer.from("private infected payload"));

    expect(result.state).toBe("infected");
    expect(result.evidence).toMatchObject({
      byteSize: 24,
      signature: "Win.Test.EICAR_HDB-1",
    });
    expect(JSON.stringify(result)).not.toContain("private infected payload");
  });

  it("stops a stream at the byte limit and returns unsupported", async () => {
    const daemon = await fakeClamd("stream: OK\0");
    daemons.push(daemon);
    const client = new ClamdInstreamClient({
      host: "127.0.0.1",
      port: daemon.port,
      maxBytes: 5,
      chunkSizeBytes: 3,
    });

    const result = await client.scan(Buffer.from("123456"));

    expect(result).toMatchObject({
      state: "unsupported",
      evidence: { byteSize: 6 },
    });
  });

  it("returns scan_failed on an absolute deadline and reports unavailability", async () => {
    const daemon = await fakeClamd(undefined);
    daemons.push(daemon);
    const metrics = new RecordingMetrics();
    const client = new ClamdInstreamClient({
      host: "127.0.0.1",
      port: daemon.port,
      timeoutMs: 20,
      metrics,
    });

    const result = await client.scan(Buffer.from("benign"));

    expect(result.state).toBe("scan_failed");
    expect(metrics.availability).toEqual([false]);
    expect(metrics.scans).toMatchObject([
      { scannerName: "clamav", state: "scan_failed", byteSize: 6 },
    ]);
  });

  it("contains failures from a streaming source", async () => {
    const daemon = await fakeClamd("stream: OK\0");
    daemons.push(daemon);
    const client = new ClamdInstreamClient({
      host: "127.0.0.1",
      port: daemon.port,
    });
    async function* brokenInput(): AsyncIterable<Uint8Array> {
      yield Buffer.from("seen");
      throw new Error("sensitive source failure");
    }

    const result = await client.scan(brokenInput());

    expect(result).toMatchObject({
      state: "scan_failed",
      evidence: { byteSize: 4 },
    });
    expect(JSON.stringify(result)).not.toContain("sensitive source failure");
  });

  it("validates bounds before opening a socket", () => {
    expect(
      () =>
        new ClamdInstreamClient({
          host: "clamav",
          port: 3310,
          chunkSizeBytes: 1024 * 1024 + 1,
        }),
    ).toThrow(/chunkSizeBytes/u);
  });
});
