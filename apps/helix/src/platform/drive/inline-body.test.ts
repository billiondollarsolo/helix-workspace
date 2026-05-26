import { describe, expect, it } from "vitest";
import { allowInlineBodyFallback, readInlineBodyFallback } from "./inline-body.js";

describe("inlineBody fallback policy", () => {
  it("allows explicit seed and legacy-dev inline bodies outside production", () => {
    expect(allowInlineBodyFallback({ source: "corpus" }, { NODE_ENV: "test" })).toBe(true);
    expect(allowInlineBodyFallback({ backfilled: true }, { NODE_ENV: "development" })).toBe(true);
    expect(allowInlineBodyFallback({ migratedFromNative: true }, { NODE_ENV: undefined })).toBe(
      true,
    );
    expect(allowInlineBodyFallback({ inlineBodyDevFallback: true }, { NODE_ENV: "test" })).toBe(
      true,
    );
  });

  it("denies arbitrary or production inline bodies", () => {
    expect(allowInlineBodyFallback({ inlineBody: "AAAA" }, { NODE_ENV: "test" })).toBe(false);
    expect(allowInlineBodyFallback({ source: "corpus" }, { NODE_ENV: "production" })).toBe(false);
    expect(
      allowInlineBodyFallback(
        { source: "corpus", status: "ready", latestVersionId: "version-1" },
        { NODE_ENV: "test" },
      ),
    ).toBe(false);
    expect(
      allowInlineBodyFallback({ migratedFromNative: true, versionNumber: 2 }, { NODE_ENV: "test" }),
    ).toBe(false);
  });

  it("decodes inline bytes only when policy allows the fallback", () => {
    const encoded = Buffer.from("seed bytes").toString("base64");

    expect(
      readInlineBodyFallback(
        { source: "corpus", inlineBody: encoded, inlineMime: "text/plain" },
        { NODE_ENV: "test" },
      ),
    ).toEqual({ body: Buffer.from("seed bytes"), mime: "text/plain" });
    expect(
      readInlineBodyFallback({ inlineBody: encoded, inlineMime: "text/plain" }, { NODE_ENV: "test" }),
    ).toBeNull();
  });
});
