import { describe, expect, it } from "vitest";
import {
  securityScanRecordSchema,
  securityScanResultSchema,
  type SecurityScanResult,
} from "./security-scanning.js";

const evidence = {
  scannerName: "clamav",
  scannerVersion: "1.4.3/27388",
  startedAt: "2026-07-28T12:00:00.000Z",
  completedAt: "2026-07-28T12:00:01.000Z",
  byteSize: 68,
};

describe("securityScanResultSchema", () => {
  it("accepts content-free clean and infected evidence", () => {
    const clean = securityScanResultSchema.parse({ state: "clean", evidence });
    const infected = securityScanResultSchema.parse({
      state: "infected",
      evidence: { ...evidence, signature: "Win.Test.EICAR_HDB-1" },
    });

    expect(clean.state).toBe("clean");
    expect(infected).toMatchObject({
      state: "infected",
      evidence: { signature: "Win.Test.EICAR_HDB-1" },
    });
  });

  it("requires a signature only for infected results", () => {
    expect(securityScanResultSchema.safeParse({ state: "infected", evidence }).success).toBe(false);
    expect(
      securityScanResultSchema.safeParse({
        state: "clean",
        evidence: { ...evidence, signature: "not-allowed" },
      }).success,
    ).toBe(false);
  });

  it("rejects content, network coordinates, and reversed timestamps", () => {
    for (const unsafeEvidence of [
      { ...evidence, content: "raw bytes" },
      { ...evidence, host: "clamav.internal" },
      {
        ...evidence,
        startedAt: "2026-07-28T12:00:02.000Z",
        completedAt: "2026-07-28T12:00:01.000Z",
      },
    ]) {
      expect(
        securityScanResultSchema.safeParse({
          state: "scan_failed",
          evidence: unsafeEvidence,
        }).success,
      ).toBe(false);
    }
  });

  it("round-trips every terminal state through one contract", () => {
    const states: readonly SecurityScanResult["state"][] = [
      "clean",
      "infected",
      "scan_failed",
      "unsupported",
    ];
    for (const state of states) {
      const result = {
        state,
        evidence:
          state === "infected" ? { ...evidence, signature: "Eicar-Test-Signature" } : evidence,
      };
      expect(securityScanResultSchema.parse(result)).toEqual(result);
    }
  });
});

describe("securityScanRecordSchema", () => {
  it("accepts pending and scanning lifecycle records", () => {
    expect(securityScanRecordSchema.parse({ state: "pending" })).toEqual({
      state: "pending",
    });
    expect(
      securityScanRecordSchema.parse({
        state: "scanning",
        scannerName: "clamav",
        scannerVersion: "unknown",
        startedAt: evidence.startedAt,
        byteSize: 0,
      }),
    ).toMatchObject({ state: "scanning", byteSize: 0 });
  });
});
