import { describe, expect, it } from "vitest";
import { inspectInboundAttachments, sanitizeMailHtml } from "./content-safety.js";

describe("mail HTML content safety", () => {
  it("drops active content, event handlers, dangerous URLs, and CSS network loads", () => {
    const result = sanitizeMailHtml(`
      <style>body { background:url(https://tracker.example/a) }</style>
      <script>steal()</script><iframe src="https://evil.example"></iframe>
      <p onclick="steal()">Safe <a href="javascript:steal()">link</a></p>
      <svg onload="steal()"><script>steal()</script></svg>
    `);
    expect(result.html).toContain("<p>Safe <a>link</a></p>");
    expect(result.html).not.toMatch(/script|iframe|onclick|javascript:|tracker\.example|svg/iu);
  });

  it("blocks remote/tracking images while preserving MIME cid images", () => {
    const result = sanitizeMailHtml(`
      <img src="https://tracker.example/pixel.gif" width="1" height="1">
      <img src="//tracker.example/pixel.gif">
      <img src="cid:logo@example" alt="Logo">
    `);
    expect(result.remoteImagesBlocked).toBe(2);
    expect(result.html).not.toContain("tracker.example");
    expect(result.html).toContain('data-helix-remote-image="blocked"');
    expect(result.html).toContain('src="cid:logo@example"');
  });

  it("quarantines executable and active-content attachment types", () => {
    expect(
      inspectInboundAttachments([
        { filename: "invoice.pdf.exe", contentType: "application/octet-stream" },
        { filename: "diagram.svg", contentType: "image/svg+xml" },
      ] as never),
    ).toMatchObject({ quarantine: true });
    expect(
      inspectInboundAttachments([
        { filename: "invoice.pdf", contentType: "application/pdf" },
      ] as never),
    ).toEqual({ quarantine: false, reasons: [] });
  });
});
