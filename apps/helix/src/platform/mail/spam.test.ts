import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SpamdScanner, parseSpamdResponse } from "./spam.js";
import { ClamavScanner, parseClamavResponse, parseClamavVersion } from "./antivirus.js";
import { ingestRawMail, scanInboundMail } from "./ingest.js";
import { CapturingMailQuarantineStore } from "./quarantine-test-store.js";
import type { MailMessageInput, MailThreadStatePatch, StoredMailMessage } from "./types.js";

/**
 * A tiny fake TCP daemon that replies with a fixed payload after consuming the
 * request. Used to exercise the spamd / clamd socket protocols without the real
 * daemons. The reply is sent shortly after the request data stops arriving,
 * which works for both the half-closing spamd client and the keep-open clamd
 * client.
 */
function fakeDaemon(
  reply: string | Buffer | ((request: Buffer) => string | Buffer),
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
      let timer: NodeJS.Timeout | undefined;
      const chunks: Buffer[] = [];
      const replyOnce = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => {
          socket.end(typeof reply === "function" ? reply(Buffer.concat(chunks)) : reply);
        }, 25);
      };
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        replyOnce();
      });
      socket.on("end", replyOnce);
      socket.on("error", () => {
        /* ignore */
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Failed to bind fake daemon."));
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

const servers: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("spamd protocol parsing", () => {
  it("parses a spam verdict with score, threshold, and symbols", () => {
    const parsed = parseSpamdResponse(
      "SPAMD/1.1 0 EX_OK\r\nContent-length: 40\r\nSpam: True ; 8.3 / 5.0\r\n\r\nBAYES_99,HTML_MESSAGE,RDNS_NONE\r\n",
    );
    expect(parsed.score).toBe(8.3);
    expect(parsed.threshold).toBe(5);
    expect(parsed.symbols).toEqual(["BAYES_99", "HTML_MESSAGE", "RDNS_NONE"]);
  });

  it("parses a clean verdict with a negative score", () => {
    const parsed = parseSpamdResponse("SPAMD/1.1 0 EX_OK\nSpam: False ; -1.2 / 5.0\n\nBAYES_00\n");
    expect(parsed.score).toBe(-1.2);
    expect(parsed.symbols).toEqual(["BAYES_00"]);
  });

  it("rejects a malformed response", () => {
    expect(() => parseSpamdResponse("garbage")).toThrow(/Unexpected spamd response/u);
  });

  it("rejects a response missing the Spam header", () => {
    expect(() => parseSpamdResponse("SPAMD/1.1 0 EX_OK\n\nbody")).toThrow(
      /missing the Spam header/u,
    );
  });
});

describe("SpamdScanner", () => {
  it("scores a message and flags it as spam above the threshold", async () => {
    const daemon = await fakeDaemon(
      "SPAMD/1.1 0 EX_OK\r\nSpam: True ; 12.0 / 5.0\r\n\r\nBAYES_99\r\n",
    );
    servers.push(daemon);
    const scanner = new SpamdScanner({ host: "127.0.0.1", port: daemon.port, threshold: 5 });
    const result = await scanner.scan("From: bad@example.com\r\n\r\nbuy now");
    expect(result.score).toBe(12);
    expect(result.isSpam).toBe(true);
    expect(result.symbols).toContain("BAYES_99");
    expect(result.evidence).toMatchObject({ scanned: true, isSpam: true });
  });

  it("does not flag a message scoring below the threshold", async () => {
    const daemon = await fakeDaemon("SPAMD/1.1 0 EX_OK\r\nSpam: False ; 1.1 / 5.0\r\n\r\n\r\n");
    servers.push(daemon);
    const scanner = new SpamdScanner({ host: "127.0.0.1", port: daemon.port, threshold: 5 });
    const result = await scanner.scan("hello");
    expect(result.isSpam).toBe(false);
  });
});

describe("clamd protocol parsing", () => {
  it("parses a clean verdict", () => {
    expect(parseClamavResponse("stream: OK\0")).toEqual({ infected: false, signature: null });
  });

  it("parses an infected verdict with the signature", () => {
    expect(parseClamavResponse("stream: Eicar-Test-Signature FOUND\0")).toEqual({
      infected: true,
      signature: "Eicar-Test-Signature",
    });
  });

  it("throws on an ERROR reply", () => {
    expect(() => parseClamavResponse("INSTREAM size limit exceeded. ERROR")).toThrow(
      /clamd returned an error/u,
    );
  });

  it("parses engine and signature database freshness", () => {
    expect(parseClamavVersion("ClamAV 1.5.4/27835/Tue Sep 2 10:33:42 2026\0")).toEqual({
      engineVersion: "1.5.4",
      signatureVersion: 27835,
      signatureUpdatedAt: new Date("2026-09-02T10:33:42.000Z"),
    });
    expect(() => parseClamavVersion("ClamAV 1.5.4/unknown")).toThrow("signature freshness");
  });
});

describe("ClamavScanner", () => {
  it("requires a valid clamd PONG for health", async () => {
    const daemon = await fakeDaemon("PONG\0");
    servers.push(daemon);
    const scanner = new ClamavScanner({ host: "127.0.0.1", port: daemon.port });

    await expect(scanner.checkHealth()).resolves.toBeUndefined();
  });

  it("reports an infected verdict from clamd", async () => {
    const daemon = await fakeDaemon("stream: Eicar-Test-Signature FOUND\0");
    servers.push(daemon);
    const scanner = new ClamavScanner({ host: "127.0.0.1", port: daemon.port });
    const result = await scanner.scan(Buffer.from("infected payload"));
    expect(result.infected).toBe(true);
    expect(result.signature).toBe("Eicar-Test-Signature");
    expect(result.scanned).toBe(true);
  });

  it("reports a clean verdict from clamd", async () => {
    const daemon = await fakeDaemon("stream: OK\0");
    servers.push(daemon);
    const scanner = new ClamavScanner({ host: "127.0.0.1", port: daemon.port });
    const result = await scanner.scan(Buffer.from("benign payload"));
    expect(result.infected).toBe(false);
  });

  it("requires a fresh loaded signature database for readiness", async () => {
    const daemon = await fakeDaemon((request) =>
      request.includes(Buffer.from("PING"))
        ? "PONG\0"
        : "ClamAV 1.5.4/27835/Tue Sep 2 10:33:42 2026\0",
    );
    servers.push(daemon);
    const scanner = new ClamavScanner({ host: "127.0.0.1", port: daemon.port });
    await expect(
      scanner.checkReadiness({
        maxSignatureAgeMs: 48 * 60 * 60 * 1_000,
        now: new Date("2026-09-03T10:33:42.000Z"),
      }),
    ).resolves.toMatchObject({ engineVersion: "1.5.4", signatureVersion: 27835 });
  });

  it("fails readiness for stale signatures and bounds a hung scan", async () => {
    const staleDaemon = await fakeDaemon((request) =>
      request.includes(Buffer.from("PING"))
        ? "PONG\0"
        : "ClamAV 1.5.4/27835/Tue Aug 1 10:33:42 2026\0",
    );
    servers.push(staleDaemon);
    const staleScanner = new ClamavScanner({ host: "127.0.0.1", port: staleDaemon.port });
    await expect(
      staleScanner.checkReadiness({
        maxSignatureAgeMs: 48 * 60 * 60 * 1_000,
        now: new Date("2026-09-03T10:33:42.000Z"),
      }),
    ).rejects.toThrow("signatures are stale");

    const slowDaemon = await fakeDaemon("stream: OK\0");
    servers.push(slowDaemon);
    const timedScanner = new ClamavScanner({
      host: "127.0.0.1",
      port: slowDaemon.port,
      timeoutMs: 5,
    });
    await expect(timedScanner.scan("slow")).resolves.toMatchObject({
      scanned: false,
      securityScan: { state: "scan_failed" },
    });
  });

  it("maps a daemon failure into the shared Business quarantine policy", async () => {
    const daemon = await fakeDaemon("INSTREAM read error. ERROR\0");
    servers.push(daemon);
    const scanner = new ClamavScanner({
      host: "127.0.0.1",
      port: daemon.port,
      tier: "business",
    });
    const result = await scanner.scan(Buffer.from("private message"));

    expect(result).toMatchObject({
      infected: false,
      scanned: false,
      disposition: "quarantine",
      securityScan: {
        state: "scan_failed",
        evidence: {
          scannerName: "clamav",
          scannerVersion: "unknown",
          byteSize: 15,
        },
      },
    });
    expect(Object.keys(result.evidence).sort()).toEqual([
      "byteSize",
      "completedAt",
      "scannerName",
      "scannerVersion",
      "startedAt",
    ]);
    expect(JSON.stringify(result)).not.toContain("private message");
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
  });
});

describe("scanInboundMail", () => {
  it("returns a no-op result when scanners are absent", async () => {
    const result = await scanInboundMail(undefined, "hello");
    expect(result.routedToSpam).toBe(false);
    expect(result.quarantined).toBe(false);
    expect(result.spam).toBeNull();
    expect(result.antivirus).toBeNull();
  });

  it("routes to spam on a high spam score", async () => {
    const result = await scanInboundMail(
      {
        spam: {
          async scan() {
            return {
              score: 9,
              thresholdReportedBySpamd: 5,
              isSpam: true,
              symbols: ["BAYES_99"],
              evidence: { scanned: true },
            };
          },
        },
      },
      "spammy",
    );
    expect(result.routedToSpam).toBe(true);
    expect(result.spamReason).toBe("spam-score");
  });

  it("routes to spam on a virus verdict, taking precedence over score", async () => {
    const result = await scanInboundMail(
      {
        spam: {
          async scan() {
            return {
              score: 0,
              thresholdReportedBySpamd: 5,
              isSpam: false,
              symbols: [],
              evidence: { scanned: true },
            };
          },
        },
        antivirus: {
          async scan() {
            return {
              infected: true,
              signature: "Win.Test.EICAR_HDB-1",
              scanned: true,
              evidence: { scanned: true },
            };
          },
        },
      },
      "infected",
    );
    expect(result.routedToSpam).toBe(true);
    expect(result.quarantined).toBe(true);
    expect(result.spamReason).toBe("virus");
  });

  it("treats a scanner outage as unscanned without failing", async () => {
    const result = await scanInboundMail(
      {
        spam: {
          async scan() {
            throw new Error("spamd unreachable");
          },
        },
      },
      "message",
    );
    expect(result.routedToSpam).toBe(false);
    expect(result.quarantined).toBe(false);
    expect(result.spam).toBeNull();
  });

  it("quarantines a Business-tier scanner failure instead of delivering it to Inbox", async () => {
    const result = await scanInboundMail(
      {
        antivirus: {
          async scan() {
            return {
              infected: false,
              signature: null,
              scanned: false,
              evidence: {
                scannerName: "clamav",
                scannerVersion: "unknown",
                startedAt: "2026-07-28T12:00:00.000Z",
                completedAt: "2026-07-28T12:00:01.000Z",
                byteSize: 7,
              },
              securityScan: {
                state: "scan_failed",
                evidence: {
                  scannerName: "clamav",
                  scannerVersion: "unknown",
                  startedAt: "2026-07-28T12:00:00.000Z",
                  completedAt: "2026-07-28T12:00:01.000Z",
                  byteSize: 7,
                },
              },
              disposition: "quarantine",
            };
          },
        },
      },
      "message",
    );

    expect(result).toMatchObject({
      routedToSpam: true,
      quarantined: true,
      spamReason: "scanner-policy",
      antivirus: {
        infected: false,
        scanned: false,
        disposition: "quarantine",
      },
    });
  });

  it("quarantines a Business-tier spamd outage even when antivirus is clean", async () => {
    const result = await scanInboundMail(
      {
        tier: "business",
        spam: {
          async scan() {
            throw new Error("spamd unreachable");
          },
        },
        antivirus: {
          async scan() {
            return {
              infected: false,
              signature: null,
              scanned: true,
              evidence: {
                scannerName: "clamav",
                scannerVersion: "test",
                startedAt: "2026-07-28T12:00:00.000Z",
                completedAt: "2026-07-28T12:00:01.000Z",
                byteSize: 7,
              },
            };
          },
        },
      },
      "message",
    );

    expect(result).toMatchObject({
      spam: null,
      antivirus: { infected: false, scanned: true },
      routedToSpam: true,
      quarantined: true,
      scannerUnavailable: true,
      spamReason: "scanner-policy",
      quarantineReasons: ["scanner_unavailable"],
    });
  });

  it("keeps a Personal-tier scanner failure explicitly unscanned without quarantine", async () => {
    const result = await scanInboundMail(
      {
        antivirus: {
          async scan() {
            return {
              infected: false,
              signature: null,
              scanned: false,
              evidence: { scannerName: "clamav", byteSize: 7 },
              disposition: "allow_unscanned",
            };
          },
        },
      },
      "message",
    );

    expect(result).toMatchObject({
      routedToSpam: false,
      quarantined: false,
      spamReason: null,
      antivirus: { scanned: false, disposition: "allow_unscanned" },
    });
  });
  it("defers delivery and emits an alert when a configured scanner is unavailable", async () => {
    const unavailable: string[] = [];
    await expect(
      scanInboundMail(
        {
          failurePolicy: "defer",
          spam: cleanSpamScanner,
          antivirus: {
            async scan() {
              throw new Error("clamd unreachable");
            },
          },
          onUnavailable: ({ scanner }) => unavailable.push(scanner),
        },
        "message",
      ),
    ).rejects.toMatchObject({ responseCode: 451 });
    expect(unavailable).toContain("antivirus");
  });

  it("defers when a required scanner is absent or skips the message", async () => {
    await expect(
      scanInboundMail({ failurePolicy: "defer", spam: cleanSpamScanner }, "message"),
    ).rejects.toMatchObject({ responseCode: 451 });
    await expect(
      scanInboundMail(
        {
          failurePolicy: "defer",
          spam: cleanSpamScanner,
          antivirus: {
            async scan() {
              return {
                infected: false,
                signature: null,
                scanned: false,
                evidence: { scanned: false, reason: "too large" },
              };
            },
          },
        },
        "message",
      ),
    ).rejects.toMatchObject({ responseCode: 451 });
  });
});

const cleanSpamScanner = {
  async scan() {
    return {
      score: 0,
      thresholdReportedBySpamd: 5,
      isSpam: false,
      symbols: [],
      evidence: { scanned: true },
    };
  },
};

/** A minimal mail store recording inbound inserts and thread-state patches. */
class RecordingMailStore {
  readonly inserted: MailMessageInput[] = [];
  readonly patches: { threadId: string; actorId: string; patch: MailThreadStatePatch }[] = [];

  async findActorByAddress(_orgId: string, address: string) {
    return { actorId: "actor-1", email: address.toLowerCase() };
  }

  async insertInboundMessage(input: MailMessageInput): Promise<StoredMailMessage> {
    this.inserted.push(input);
    return {
      threadId: "thread-1",
      messageId: "message-1",
      attachmentObjectIds: [],
      created: true,
      deliveredActorIds: input.mailboxActorIds ?? [],
    };
  }

  async updateThreadState(input: {
    readonly threadId: string;
    readonly actorId: string;
    readonly patch: MailThreadStatePatch;
  }): Promise<void> {
    this.patches.push({ threadId: input.threadId, actorId: input.actorId, patch: input.patch });
  }

  async listFilters() {
    return [];
  }

  async getActiveVacation() {
    return null;
  }
}

const trustedAuthenticator = {
  async authenticate() {
    return { spf: "none", dkim: "none", dmarc: "none", arc: "none" } as const;
  },
};

const rawMessage =
  "From: sender@external.test\r\nTo: user@helix.test\r\nSubject: Promo\r\n\r\nbuy now\r\n";

describe("ingest spam routing", () => {
  it("does not persist mail when secure scanning is unavailable", async () => {
    const store = new RecordingMailStore();
    await expect(
      ingestRawMail({
        store: store as never,
        authenticator: trustedAuthenticator,
        scanners: {
          failurePolicy: "defer",
          spam: cleanSpamScanner,
          antivirus: {
            async scan() {
              throw new Error("clamd offline");
            },
          },
        },
        input: {
          orgId: "org-1",
          recipients: [{ orgId: "org-1", actorId: "actor-1", address: "user@helix.test" }],
          raw: rawMessage,
        },
      }),
    ).rejects.toMatchObject({ responseCode: 451 });
    expect(store.inserted).toHaveLength(0);
  });

  it("routes a high-scoring message to the recipient's Spam folder", async () => {
    const store = new RecordingMailStore();
    const result = await ingestRawMail({
      store: store as never,
      authenticator: trustedAuthenticator,
      scanners: {
        spam: {
          async scan() {
            return {
              score: 11,
              thresholdReportedBySpamd: 5,
              isSpam: true,
              symbols: ["BAYES_99"],
              evidence: { scanned: true },
            };
          },
        },
      },
      input: {
        orgId: "org-1",
        recipients: [{ orgId: "org-1", actorId: "actor-1", address: "user@helix.test" }],
        raw: rawMessage,
        envelopeFrom: "sender@external.test",
      },
    });
    expect(result.scan.routedToSpam).toBe(true);
    expect(result.scan.spamReason).toBe("spam-score");
    const spamPatch = store.patches.find((entry) => entry.patch.spamAt !== undefined);
    expect(spamPatch).toBeDefined();
    expect(spamPatch?.threadId).toBe("thread-1");
    // The spam score + symbols are persisted on the message metadata.
    expect(store.inserted[0]?.metadata?.spam).toMatchObject({
      routedToSpam: true,
      score: 11,
      symbols: ["BAYES_99"],
    });
  });

  it("leaves a clean message in the inbox (no spam patch)", async () => {
    const store = new RecordingMailStore();
    const result = await ingestRawMail({
      store: store as never,
      authenticator: trustedAuthenticator,
      scanners: {
        spam: {
          async scan() {
            return {
              score: 0.2,
              thresholdReportedBySpamd: 5,
              isSpam: false,
              symbols: [],
              evidence: { scanned: true },
            };
          },
        },
      },
      input: {
        orgId: "org-1",
        recipients: [{ orgId: "org-1", actorId: "actor-1", address: "user@helix.test" }],
        raw: rawMessage,
        envelopeFrom: "sender@external.test",
      },
    });
    expect(result.scan.routedToSpam).toBe(false);
    expect(store.patches.some((entry) => entry.patch.spamAt !== undefined)).toBe(false);
  });

  it("quarantines an infected message instead of inserting it into Spam", async () => {
    const store = new RecordingMailStore();
    const quarantineStore = new CapturingMailQuarantineStore();
    await expect(
      ingestRawMail({
        store: store as never,
        quarantineStore,
        authenticator: trustedAuthenticator,
        scanners: {
          antivirus: {
            async scan() {
              return {
                infected: true,
                signature: "Eicar-Test-Signature",
                scanned: true,
                evidence: { scanned: true },
              };
            },
          },
        },
        input: {
          orgId: "org-1",
          recipients: [{ orgId: "org-1", actorId: "actor-1", address: "user@helix.test" }],
          raw: rawMessage,
        },
      }),
    ).rejects.toMatchObject({ name: "MailInboundQuarantinedError" });
    expect(await quarantineStore.listPending("org-1")).toHaveLength(1);
    expect(store.inserted).toHaveLength(0);
    expect(store.patches).toHaveLength(0);
  });
});
