import fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  SANDBOXED_PREVIEW_CSP,
  safeDriveContentHeaders,
  sanitizePreviewFragment,
  sendSandboxedHtmlPreview,
} from "./preview-security.js";

describe("Drive active-content preview isolation", () => {
  it("removes script, event, network, navigation, and form vectors from converted HTML", () => {
    const safe = sanitizePreviewFragment(`
      <script>window.parent.location='https://evil.example/script'</script>
      <p onclick="fetch('https://evil.example/event')">Keep me</p>
      <img src="https://evil.example/pixel" onerror="alert(document.cookie)">
      <a href="https://evil.example/navigation" target="_parent">leave</a>
      <form action="https://evil.example/form"><input formaction="https://evil.example/submit"></form>
      <style>@import url(https://evil.example/style); body { background: url(https://evil.example/image) }</style>
      <iframe src="https://evil.example/frame"></iframe>
      <object data="https://evil.example/object"></object>
    `);

    expect(safe).toContain("<p>Keep me</p>");
    expect(safe).toContain("<a>leave</a>");
    expect(safe).not.toMatch(/script|onclick|onerror|href|target|form|input|style|iframe|object/iu);
    expect(safe).not.toContain("evil.example");
    expect(safe).not.toContain("document.cookie");
  });

  it("serves generated HTML in an opaque, no-network sandbox", async () => {
    const app = fastify();
    app.get("/preview", async (_request, reply) =>
      sendSandboxedHtmlPreview(reply, "<!doctype html><p>safe</p>"),
    );

    const response = await app.inject("/preview");
    const csp = response.headers["content-security-policy"] ?? "";

    expect(response.statusCode).toBe(200);
    expect(csp).toBe(SANDBOXED_PREVIEW_CSP);
    expect(csp).toContain("sandbox");
    expect(csp).not.toMatch(/allow-same-origin|allow-scripts|allow-forms|allow-top-navigation/iu);
    for (const directive of [
      "default-src 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "script-src 'none'",
      "connect-src 'none'",
      "img-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["permissions-policy"]).toContain("camera=()");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });

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
