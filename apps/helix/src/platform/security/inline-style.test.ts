import { describe, expect, it } from "vitest";
import { sanitizeInlineStyle } from "./inline-style.js";

describe("inline style allowlist", () => {
  it.each([
    ["color: #1A73E8", "color: #1a73e8"],
    ["color: rgb(217, 48, 37)", "color: rgb(217, 48, 37)"],
    ["color: rgb(217 48 37 / 50%)", "color: rgb(217 48 37 / 50%)"],
    ["background-color: hsla(210, 50%, 40%, 0.5)", "background-color: hsla(210, 50%, 40%, 0.5)"],
    ["background-color: yellow", "background-color: yellow"],
    ["font-size: x-large", "font-size: x-large"],
    ["font-size: 1.25em", "font-size: 1.25em"],
    ["font-weight: 700", "font-weight: 700"],
    ["font-style: italic", "font-style: italic"],
    ["text-decoration: underline line-through", "text-decoration: underline line-through"],
    ["TEXT-ALIGN: Center", "text-align: center"],
    ["margin-left: 40px; padding-left: 0", "margin-left: 40px; padding-left: 0"],
  ])("keeps %s", (input, expected) => {
    expect(sanitizeInlineStyle(input)).toBe(expected);
  });

  it.each([
    "background-color: url(https://evil.example/t.png)",
    "color: expression(alert(1))",
    "color: var(--brand)",
    "color: env(safe-area-inset-top)",
    "color: rgb(1, 2, 3) url(x)",
    "font-size: calc(100vh + 1px)",
    "font-size: 99999px",
    "font-size: 12vh",
    "margin-left: -200px",
    "padding-left: 10px 20px",
    "position: fixed",
    "display: none",
    "z-index: 9999",
    "behavior: url(x.htc)",
    "-moz-binding: url(x.xml#xss)",
    "text-align: center !important",
    "text-decoration: underline url(x)",
    "font-weight: 950",
    "color: #12345",
    "color: red\u0000",
  ])("drops %s", (input) => {
    expect(sanitizeInlineStyle(input)).toBe("");
  });

  it("rejects the whole attribute when it carries escapes, entities, or comments", () => {
    expect(sanitizeInlineStyle("color: red; background-color: u\\72l(x)")).toBe("");
    expect(sanitizeInlineStyle("color: red; font-size: 1&#x32;px")).toBe("");
    expect(sanitizeInlineStyle("color: red/**/; font-size: 12px")).toBe("");
  });

  it("keeps the valid declarations next to invalid ones", () => {
    expect(sanitizeInlineStyle("position: absolute; color: navy; top: 0; font-size: 14pt")).toBe(
      "color: navy; font-size: 14pt",
    );
  });
});
