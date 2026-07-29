import { describe, expect, it } from "vitest";
import {
  hashDriveSharePassword,
  hashDriveShareToken,
  safeDriveDownloadPolicy,
  verifyDriveSharePassword,
} from "./share-link-security.js";

describe("Drive share-link security", () => {
  it("stores deterministic token hashes and salted password verifiers", async () => {
    expect(hashDriveShareToken("secret")).toMatch(/^[a-f0-9]{64}$/u);
    const encoded = await hashDriveSharePassword("correct horse");
    expect(encoded).not.toContain("correct horse");
    await expect(verifyDriveSharePassword("correct horse", encoded)).resolves.toBe(true);
    await expect(verifyDriveSharePassword("wrong", encoded)).resolves.toBe(false);
  });

  it.each(["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml"])(
    "forces active MIME %s to an opaque attachment",
    (mimeType) => {
      expect(safeDriveDownloadPolicy({ mimeType, requestedInline: true })).toEqual({
        mimeType: "application/octet-stream",
        disposition: "attachment",
      });
    },
  );
});
