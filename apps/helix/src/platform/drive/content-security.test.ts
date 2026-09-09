import { describe, expect, it } from "vitest";
import { safeDriveContentHeaders } from "./content-security.js";

describe("Drive active-content preview isolation", () => {
  it.each([
    ["attack.txt", "text/html; charset=utf-8"],
    ["attack.html", "text/plain"],
    ["attack.svg", "application/octet-stream"],
    ["attack.xml", "application/octet-stream"],
    ["attack.mhtml", "multipart/related"],
    ["attack.js", "text/plain"],
  ])("forces active content %s (%s) to download as inert bytes", (filename, mimeType) => {
    expect(safeDriveContentHeaders(filename, mimeType, true)).toEqual({
      disposition: expect.stringMatching(/^attachment;/u),
      mimeType: "application/octet-stream",
    });
  });

  it("keeps a known inert raster preview inline", () => {
    expect(safeDriveContentHeaders("photo.png", "image/png", true)).toEqual({
      disposition: expect.stringMatching(/^inline;/u),
      mimeType: "image/png",
    });
  });
});
