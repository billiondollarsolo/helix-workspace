import { contactImportInputSchema } from "@helix/contracts";
import { describe, expect, it } from "vitest";
import { readContactCard } from "./contact-card.js";
import { parseContactImport, parseCsv } from "./contact-import.js";

const twoCards = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "UID:one",
  "FN:Ada Lovelace",
  "EMAIL:ada@example.com",
  "X-CUSTOM:kept",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:2.1",
  "FN:Too Old",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:4.0",
  "UID:empty",
  "NOTE:no identity",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:4.0",
  "UID:two",
  "N:Hopper;Grace;;;",
  "FN:Grace Hopper",
  "END:VCARD",
  "",
].join("\n");

describe("contact import", () => {
  it("keeps valid vCards whole and explains each skipped card", () => {
    const result = parseContactImport({ format: "vcard", content: twoCards });

    expect(result.cards.map((card) => [card.uid, card.displayName])).toEqual([
      ["one", "Ada Lovelace"],
      ["two", "Grace Hopper"],
    ]);
    expect(result.cards[0]?.vcard).toContain("X-CUSTOM:kept");
    expect(result.skipped).toBe(2);
    expect(result.problems).toEqual([
      "Card 2: it is not a valid vCard 3.0 or 4.0 card.",
      "Card 3: it has no name, company, email or phone.",
    ]);
  });

  it("adds the import label to every card", () => {
    const result = parseContactImport({ format: "vcard", content: twoCards, label: "Imported" });

    expect(result.cards.map((card) => readContactCard(card.vcard).labels)).toEqual([
      ["Imported"],
      ["Imported"],
    ]);
  });

  it("reads the Google Contacts CSV layout", () => {
    const csv = [
      "First Name,Last Name,Organization Name,Organization Title,Birthday,Notes,Labels,E-mail 1 - Label,E-mail 1 - Value,Phone 1 - Label,Phone 1 - Value,Address 1 - Label,Address 1 - Street,Address 1 - City,Address 1 - Postal Code,Address 1 - Country",
      'Ada,Lovelace,Engines,Analyst,1815-12-10,"Wrote ""notes"", twice",* myContacts ::: Family ::: Science,* Work,ada@example.com,Mobile,+44 20 7946 0000,Home,12 Byron St,London,N1,UK',
      ",,,,,,,,,,,,,,,",
      "Nobody,,,,,,,,not-an-email,,,,,,,",
    ].join("\r\n");
    const result = parseContactImport({ format: "csv", content: csv });

    expect(result.skipped).toBe(0);
    expect(result.cards).toHaveLength(2);
    expect(readContactCard(result.cards[0]?.vcard ?? "")).toMatchObject({
      displayName: "Ada Lovelace",
      company: "Engines",
      jobTitle: "Analyst",
      birthday: "1815-12-10",
      notes: 'Wrote "notes", twice',
      labels: ["Family", "Science"],
      emails: [{ type: "work", value: "ada@example.com" }],
      phones: [{ type: "mobile", value: "+44 20 7946 0000" }],
      addresses: [
        { type: "home", street: "12 Byron St", city: "London", postalCode: "N1", country: "UK" },
      ],
    });
    expect(readContactCard(result.cards[1]?.vcard ?? "").emails).toEqual([]);
  });

  it("reads the Outlook CSV layout", () => {
    const csv = [
      "First Name,Last Name,E-mail Address,Mobile Phone,Business Phone,Company,Job Title,Birthday,Categories",
      "Grace,Hopper,grace@example.org,555 0100,555 0101,Navy,Admiral,12/9/1906,Navy;Compilers",
    ].join("\n");
    const card = readContactCard(
      parseContactImport({ format: "csv", content: csv }).cards[0]?.vcard ?? "",
    );

    expect(card).toMatchObject({
      displayName: "Grace Hopper",
      emails: [{ type: "other", value: "grace@example.org" }],
      phones: [
        { type: "mobile", value: "555 0100" },
        { type: "work", value: "555 0101" },
      ],
      birthday: "1906-12-09",
      labels: ["Navy", "Compilers"],
    });
  });

  it("reports a row that has no identity", () => {
    const result = parseContactImport({ format: "csv", content: "Notes\nJust a note\n" });

    expect(result).toMatchObject({
      cards: [],
      skipped: 1,
      problems: ["Row 2: it has no name, company, email or phone."],
    });
  });

  it("says when a file has no contacts", () => {
    expect(parseContactImport({ format: "vcard", content: "hello" }).problems).toEqual([
      "No contacts were found in this vCard file.",
    ]);
  });

  it("rejects files over the size limit before parsing", () => {
    const parsed = contactImportInputSchema.safeParse({
      format: "vcard",
      content: "x".repeat(900 * 1024 + 1),
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(
      "The file is larger than 900 KB. Split it and import each part.",
    );
  });

  it("parses quoted CSV fields with commas, quotes and line breaks", () => {
    expect(parseCsv('a,"b, c","d ""e""\nf"\r\n1,2,3')).toEqual([
      ["a", "b, c", 'd "e"\nf'],
      ["1", "2", "3"],
    ]);
  });
});
