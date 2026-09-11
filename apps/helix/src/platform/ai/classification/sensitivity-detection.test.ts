import { describe, expect, it } from "vitest";
import { detectDlp } from "../../dlp.js";
import { deriveClassification } from "./policy.js";

const scan = (content: string) =>
  deriveClassification({ content, scanContent: true }).classification;
const calendar =
  "Today 1 2 3 4 5 6 7 *8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30. Avg. Hi. Avg. Lo. Actual Hi. Actual Lo. Forecast Hi. Forecast Lo.";

describe("shared sensitivity detection", () => {
  it.each([
    calendar,
    "Alligator attacks child swimming in restricted Florida waters",
    "The airline restricted baggage size on this route.",
    "The meeting discussed how air-gapped networks work.",
  ])("keeps ordinary public prose and calendar days standard: %s", (text) => {
    expect(scan(text)).toBe("standard");
    expect(detectDlp(text, new Set(["credit_card", "credentials", "pii"]))).toEqual([]);
  });

  it.each([
    "RESTRICTED",
    "[RESTRICTED]",
    "# Restricted",
    "**RESTRICTED**",
    "Classification: restricted",
    "Security classification = restricted",
    "Restricted project details",
    "This document is restricted.",
    "Restricted: customer records",
    "Export controlled data",
    "AIR-GAPPED",
    "restricted documents",
    "The restricted roadmap moved",
    "This roadmap is restricted.",
  ])("retains recognizable restricted markings: %s", (text) => {
    expect(scan(text)).toBe("restricted");
  });

  it.each(["CONFIDENTIAL", "[Confidential]", "Sensitivity: confidential", "Confidential data"])(
    "retains confidential markings: %s",
    (text) => {
      expect(scan(text)).toBe("confidential");
    },
  );

  it.each([
    "4111111111111111",
    "4111 1111 1111 1111",
    "4111-1111-1111-1111",
    "378282246310005",
    "3782 822463 10005",
    "3782-822463-10005",
    "3056 930902 5904",
    "4222 2222 2222 2",
    "4111  1111\t1111--1111",
  ])("detects valid continuous and conventional grouped PANs: %s", (card) => {
    const text = `Payment: (${card}).`;
    expect(scan(text)).toBe("confidential");
    expect(detectDlp(text, new Set(["credit_card"]))).toEqual([
      { detector: "credit_card", classification: "confidential" },
    ]);
  });

  it.each([
    "4111111111111112",
    "4111 1111 1111 1112",
    "012345678901234567890123",
    "4111-1111-1111-1111-1111",
    "1234-4111-1111-1111-1111",
    calendar,
  ])("rejects invalid checksums and substrings of numeric sequences: %s", (text) => {
    expect(scan(text)).toBe("standard");
    expect(detectDlp(text, new Set(["credit_card"]))).toEqual([]);
  });

  it.each([
    "4111 1111 1111 1111 2026",
    "99 4111 1111 1111 1111",
    "4111111111111111 50",
    "4111-1111-1111-1111 2026",
  ])("retains a real PAN next to a separate amount or year: %s", (text) => {
    expect(scan(text)).toBe("confidential");
    expect(detectDlp(text, new Set(["credit_card"]))).toHaveLength(1);
  });

  it("preserves credential/PII detection and stronger explicit classifications", () => {
    expect(scan("SSN 123-45-6789")).toBe("confidential");
    expect(scan("api_key=private_test_value_123456")).toBe("restricted");
    expect(scan("-----BEGIN PRIVATE KEY-----")).toBe("restricted");
    expect(
      deriveClassification({ content: calendar, scanContent: true, explicit: "restricted" })
        .classification,
    ).toBe("restricted");
    expect(
      deriveClassification({ content: calendar, scanContent: true, labels: ["confidential"] })
        .classification,
    ).toBe("confidential");
  });
});
