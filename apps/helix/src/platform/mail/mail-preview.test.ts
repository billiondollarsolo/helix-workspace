import { describe, expect, it } from "vitest";
import { mailPreviewText } from "./store-thread-projection.js";

describe("mail list and search previews", () => {
  const html =
    '<style>p{color:red}</style><p style="color:#c0392b;text-align:center">Centered <b>bold</b></p>' +
    "<div>Q&amp;A&nbsp;today</div>";

  it("previews an HTML message by its text part, never its markup", () => {
    expect(
      mailPreviewText({ body: html, bodyFormat: "html", plainBody: "Hello Bob, report attached." }),
    ).toBe("Hello Bob, report attached.");
  });

  it("reduces HTML without a text part to its visible text", () => {
    expect(mailPreviewText({ body: html, bodyFormat: "html" })).toBe("Centered bold Q&A today");
  });

  it("keeps plain-text bodies as written, angle brackets included", () => {
    expect(mailPreviewText({ body: "Use <b> for bold", bodyFormat: "plain" })).toBe(
      "Use <b> for bold",
    );
    expect(mailPreviewText({ body: "x".repeat(300), bodyFormat: "plain" })).toHaveLength(240);
  });
});
