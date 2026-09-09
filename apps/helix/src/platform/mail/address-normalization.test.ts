import { describe, expect, it } from "vitest";
import {
  MailAddressNormalizationError,
  normalizeMailDomain,
  normalizeMailboxAddress,
} from "./address-normalization.js";

describe("normalizeMailDomain", () => {
  it.each([
    ["Example.COM", "example.com"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["例え.テスト", "xn--r8jz45g.xn--zckzah"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeMailDomain(input)).toBe(expected);
  });

  it.each([
    "",
    ".example.com",
    "example..com",
    "example.com.",
    "-example.com",
    "example-.com",
    "exa_mple.com",
    " example.com",
    "example.com ",
    "example\u0000.com",
    "\ud800.example",
  ])("rejects invalid domain %j", (input) => {
    expect(() => normalizeMailDomain(input)).toThrow(MailAddressNormalizationError);
  });

  it("rejects DNS labels and domains beyond their byte limits", () => {
    expect(() => normalizeMailDomain(`${"a".repeat(64)}.example`)).toThrowError(
      expect.objectContaining({ code: "invalid_domain" }),
    );
    expect(() =>
      normalizeMailDomain(
        `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`,
      ),
    ).toThrowError(expect.objectContaining({ code: "oversized" }));
  });
});

describe("normalizeMailboxAddress", () => {
  it("case-folds the local part and IDNA-normalizes the domain", () => {
    expect(normalizeMailboxAddress("Admin.Notices@BÜCHER.example")).toEqual({
      address: "admin.notices@xn--bcher-kva.example",
      localPart: "admin.notices",
      domain: "xn--bcher-kva.example",
    });
  });

  it.each([
    "",
    "@example.com",
    "admin@",
    "a@@example.com",
    ".admin@example.com",
    "admin.@example.com",
    "admin..ops@example.com",
    '"admin"@example.com',
    "føø@example.com",
    "admin @example.com",
    "admin@example.com\nBcc: attacker@example.net",
  ])("rejects unsupported or unsafe address %j", (input) => {
    expect(() => normalizeMailboxAddress(input)).toThrow(MailAddressNormalizationError);
  });

  it("enforces local-part and complete-address limits", () => {
    expect(() => normalizeMailboxAddress(`${"a".repeat(65)}@example.com`)).toThrowError(
      expect.objectContaining({ code: "oversized" }),
    );
    expect(() =>
      normalizeMailboxAddress(
        `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`,
      ),
    ).toThrowError(expect.objectContaining({ code: "oversized" }));
  });
});
