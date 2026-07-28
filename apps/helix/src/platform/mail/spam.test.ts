import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SpamdScanner, getSpamdScannerConfig, parseSpamdResponse } from "./spam.js";
import { ClamavScanner, getClamavScannerConfig, parseClamavResponse } from "./antivirus.js";
import { ingestRawMail, scanInboundMail } from "./ingest.js";
import { InMemoryMailQuarantineStore } from "./quarantine.js";
import type { MailMessageInput, MailThreadStatePatch, StoredMailMessage } from "./types.js";

/**
 * A tiny fake TCP daemon that replies with a fixed payload after consuming the
 * request. Used to exercise the spamd / clamd socket protocols without the real
 * daemons. The reply is sent shortly after the request data stops arriving,
 * which works for both the half-closing spamd client and the keep-open clamd
 * client.
 */
function fakeDaemon(reply: string | Buffer): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
      let timer: NodeJS.Timeout | undefined;
      const replyOnce = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => {
          socket.end(reply);
        }, 25);
      };
      socket.on("data", replyOnce);
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
});

describe("ClamavScanner", () => {
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
});

/** A minimal mail store recording inbound inserts and thread-state patches. */
class RecordingMailStore {
  readonly inserted: MailMessageInput[] = [];
  readonly patches: { threadId: string; actorId: string; patch: MailThreadStatePatch }[] = [];

  async findActorByAddress(_orgId: string, address: string) {
    return { actorId: "actor-1", email: address.toLowerCase() };
  }

  async insertInboundMessage(input: MailMessageInput): Promise<StoredMailMessage> {
    this.inserted.push(input);
    return { threadId: "thread-1", messageId: "message-1", attachmentObjectIds: [] };
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
        raw: rawMessage,
        envelopeFrom: "sender@external.test",
        envelopeTo: ["user@helix.test"],
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
        raw: rawMessage,
        envelopeFrom: "sender@external.test",
        envelopeTo: ["user@helix.test"],
      },
    });
    expect(result.scan.routedToSpam).toBe(false);
    expect(store.patches.some((entry) => entry.patch.spamAt !== undefined)).toBe(false);
  });

  it("quarantines an infected message instead of inserting it into Spam", async () => {
    const store = new RecordingMailStore();
    const quarantineStore = new InMemoryMailQuarantineStore();
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
          raw: rawMessage,
          envelopeTo: ["user@helix.test"],
        },
      }),
    ).rejects.toMatchObject({ name: "MailInboundQuarantinedError" });
    expect(await quarantineStore.list("org-1")).toHaveLength(1);
    expect(store.inserted).toHaveLength(0);
    expect(store.patches).toHaveLength(0);
  });
});

describe("config gating", () => {
  it("returns undefined when spamd is disabled", () => {
    expect(getSpamdScannerConfig({})).toBeUndefined();
  });

  it("reads spamd config from the environment", () => {
    const config = getSpamdScannerConfig({
      MAIL_SPAMD_ENABLED: "true",
      MAIL_SPAMD_HOST: "spam.internal",
      MAIL_SPAMD_PORT: "7830",
      MAIL_SPAMD_THRESHOLD: "6.5",
    });
    expect(config).toEqual({ host: "spam.internal", port: 7830, threshold: 6.5 });
  });

  it("returns undefined when clamav is disabled", () => {
    expect(getClamavScannerConfig({})).toBeUndefined();
  });

  it("reads clamav config from the environment", () => {
    const config = getClamavScannerConfig({
      MAIL_CLAMAV_ENABLED: "1",
      MAIL_CLAMAV_HOST: "av.internal",
      MAIL_CLAMAV_PORT: "3310",
    });
    expect(config).toEqual({ host: "av.internal", port: 3310 });
  });
});
