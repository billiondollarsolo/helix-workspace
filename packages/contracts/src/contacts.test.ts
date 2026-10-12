import { describe, expect, it } from "vitest";
import {
  CONTACT_LIMITS,
  contactAddressSchema,
  contactImportInputSchema,
  contactLabelApplyInputSchema,
  contactLabelNameSchema,
  contactMergeInputSchema,
} from "./contacts.js";

const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";

describe("contacts trust boundary", () => {
  it("requires a usable address and prevents newline injection in address and label fields", () => {
    const address = { type: "work", street: "", city: "", region: "", postalCode: "", country: "" };
    expect(contactAddressSchema.safeParse(address).success).toBe(false);
    expect(contactAddressSchema.parse({ ...address, city: " Paris " }).city).toBe("Paris");
    expect(contactAddressSchema.safeParse({ ...address, city: "Paris\nInjected" }).success).toBe(
      false,
    );
    expect(contactLabelNameSchema.safeParse("Work\rInjected").success).toBe(false);
  });

  it("bounds imports by UTF-8 bytes instead of character count", () => {
    const parse = (content: string) =>
      contactImportInputSchema.safeParse({ format: "csv", content });
    expect(parse("a".repeat(CONTACT_LIMITS.importBytes)).success).toBe(true);
    expect(parse("a".repeat(CONTACT_LIMITS.importBytes + 1)).success).toBe(false);
    expect(parse("é".repeat(CONTACT_LIMITS.importBytes / 2 + 1)).success).toBe(false);
    expect(parse("").success).toBe(false);
  });

  it("rejects no-op label actions and merging a contact into itself", () => {
    expect(contactLabelApplyInputSchema.safeParse({ ids: [first] }).success).toBe(false);
    expect(contactLabelApplyInputSchema.parse({ ids: [first], add: ["Work"] }).remove).toEqual([]);
    expect(contactMergeInputSchema.safeParse({ targetId: first, sourceIds: [first] }).success).toBe(
      false,
    );
    expect(
      contactMergeInputSchema.parse({ targetId: first, sourceIds: [second] }).sourceIds,
    ).toEqual([second]);
  });
});
