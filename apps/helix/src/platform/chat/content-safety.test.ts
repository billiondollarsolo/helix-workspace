import { describe, expect, it } from "vitest";
import { CHAT_BODY_MAX_BYTES, CHAT_METADATA_MAX_BYTES } from "@helix/contracts";
import type { JsonObject } from "@helix/sdk-types";
import { isSafeChatLink, normalizeChatContent, renderChatBodyHtml } from "./content-safety.js";

describe("Chat content safety", () => {
  it("defaults to plain text and escapes every HTML execution surface", () => {
    const normalized = normalizeChatContent({
      body: `<img src=x onerror=alert(1)><script>alert(2)</script>`,
      metadata: {
        unfurl: "http://169.254.169.254/latest/meta-data",
        kept: true,
        nested: { linkPreview: "https://internal.invalid", safe: "yes" },
      },
    });

    expect(normalized.bodyFormat).toBe("plain");
    expect(normalized.metadata).toEqual({ kept: true, nested: { safe: "yes" } });
    expect(renderChatBodyHtml(normalized.body, normalized.bodyFormat)).toBe(
      "<p>&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(2)&lt;/script&gt;</p>",
    );
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "//evil.example/path",
    "/relative/server/path",
    "https://user:secret@example.com/",
    "https://example.com/\u0000hidden",
  ])("rejects unsafe Chat Markdown URL %s", (url) => {
    expect(isSafeChatLink(url)).toBe(false);
    const html = renderChatBodyHtml(`[open](${url})`, "markdown");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<script");
  });

  it("renders only safe links with external indicators and never renders image embeds", () => {
    const html = renderChatBodyHtml(
      `# Links\n[site](https://example.com/path) [mail](mailto:help@example.com) ![pixel](https://tracker.example/p.gif)`,
      "markdown",
    );
    expect(html).toContain('href="https://example.com/path"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain("(external link)");
    expect(html).toContain('href="mailto:help@example.com"');
    expect(html).toContain("[image: pixel]");
    expect(html).not.toContain("<img");
  });

  it("rejects oversized UTF-8 bodies, oversized metadata, and malformed Unicode", () => {
    expect(() => normalizeChatContent({ body: "é".repeat(CHAT_BODY_MAX_BYTES / 2 + 1) })).toThrow(
      "UTF-8 bytes",
    );
    expect(() =>
      normalizeChatContent({
        body: "ok",
        metadata: { value: "x".repeat(CHAT_METADATA_MAX_BYTES) },
      }),
    ).toThrow("Metadata exceeds");
    expect(() => normalizeChatContent({ body: "bad \ud800 value" })).toThrow("malformed Unicode");
    expect(() =>
      normalizeChatContent({
        body: "ok",
        metadata: { bad: "\ud800" },
      }),
    ).toThrow("JSON serializable");
  });

  it("rejects unsupported formats and cyclic/deep metadata", () => {
    expect(() => normalizeChatContent({ body: "ok", bodyFormat: "html" })).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => normalizeChatContent({ body: "ok", metadata: cyclic as JsonObject })).toThrow(
      "JSON serializable",
    );
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let index = 0; index < 14; index += 1) {
      deep.next = {};
      deep = deep.next as Record<string, unknown>;
    }
    expect(() => normalizeChatContent({ body: "ok", metadata: root as JsonObject })).toThrow(
      "maximum depth",
    );
  });
});
