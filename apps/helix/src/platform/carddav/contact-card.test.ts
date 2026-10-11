import { contactFieldsSchema } from "@helix/contracts";
import { describe, expect, it } from "vitest";
import {
  contactDisplayName,
  readContactCard,
  uniqueLabels,
  writeContactCard,
} from "./contact-card.js";

const appleCard = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "UID:apple-1",
  "FN:Dr. Ada Lovelace",
  "N:Lovelace;Ada;Augusta;Dr.;",
  "ORG:Analytical Engines;Research",
  "TITLE:Mathematician",
  "EMAIL;TYPE=INTERNET,WORK:ada@engines.example",
  "EMAIL;type=HOME;type=pref:ada@home.example",
  "TEL;TYPE=CELL:+44 20 7946 0000",
  "TEL;TYPE=VOICE:+44 20 7946 0001",
  "ADR;TYPE=WORK:;Suite 4;12 Byron St;London;;N1 9GU;UK",
  "BDAY:1815-12-10",
  "NOTE:First programmer",
  "CATEGORIES:Family,Science",
  "URL:https://ada.example",
  "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRg==",
  "X-HELIX-FAVORITE:true",
  "END:VCARD",
].join("\r\n");

describe("contact cards", () => {
  it("reads typed fields from a vCard 3.0 card written by another client", () => {
    expect(readContactCard(appleCard)).toEqual({
      displayName: "Dr. Ada Lovelace",
      givenName: "Ada",
      familyName: "Lovelace",
      company: "Analytical Engines",
      jobTitle: "Mathematician",
      emails: [
        { type: "work", value: "ada@engines.example" },
        { type: "home", value: "ada@home.example" },
      ],
      phones: [
        { type: "mobile", value: "+44 20 7946 0000" },
        { type: "main", value: "+44 20 7946 0001" },
      ],
      addresses: [
        {
          type: "work",
          street: "Suite 4, 12 Byron St",
          city: "London",
          region: "",
          postalCode: "N1 9GU",
          country: "UK",
        },
      ],
      birthday: "1815-12-10",
      notes: "First programmer",
      labels: ["Family", "Science"],
      photoDataUrl: null,
      starred: true,
    });
  });

  it("changes only the properties behind the given fields", () => {
    const written = writeContactCard(appleCard, { labels: ["Science", "Board"], starred: false });

    expect(written).toContain("PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRg==");
    expect(written).toContain("URL:https://ada.example");
    expect(written).toContain("FN:Dr. Ada Lovelace");
    expect(written).toContain("N:Lovelace;Ada;Augusta;Dr.;");
    expect(written).toContain("TEL;TYPE=CELL:+44 20 7946 0000");
    expect(written).not.toContain("X-HELIX-FAVORITE");
    expect(readContactCard(written).labels).toEqual(["Science", "Board"]);
  });

  it("renames the card when the name changes and keeps name prefixes", () => {
    const written = writeContactCard(appleCard, { givenName: "Augusta Ada" });

    expect(written).toContain("FN:Augusta Ada Lovelace");
    expect(written).toContain("N:Lovelace;Augusta Ada;Augusta;Dr.;");
  });

  it("round-trips a new contact through vCard 4.0", () => {
    const fields = contactFieldsSchema.parse({
      givenName: "Grace",
      familyName: "Hopper",
      company: "Navy; Research",
      emails: [{ type: "other", value: "grace@example.org" }],
      phones: [{ type: "work", value: "+1 555 0100" }],
      addresses: [
        {
          type: "home",
          street: "1 Main St, Apt 2",
          city: "Arlington",
          region: "VA",
          postalCode: "22201",
          country: "US",
        },
      ],
      birthday: "--12-09",
      notes: "Line one\nLine two, with commas; and semicolons",
      labels: ["Navy", "navy", "Compilers"],
      photoDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      starred: true,
    });
    const card = writeContactCard(null, fields);

    expect(card).toMatch(/^BEGIN:VCARD\r\nVERSION:4\.0\r\nUID:urn:uuid:/u);
    expect(readContactCard(card)).toEqual({
      ...fields,
      labels: ["Navy", "Compilers"],
      displayName: "Grace Hopper",
    });
  });

  it("names a card from its company, email or phone when it has no person name", () => {
    expect(
      contactDisplayName({
        givenName: "",
        familyName: "",
        company: "",
        emails: [],
        phones: [{ type: "mobile", value: "+1 555 0199" }],
      }),
    ).toBe("+1 555 0199");
    const card = writeContactCard(null, contactFieldsSchema.parse({ company: "Acme" }));
    expect(readContactCard(card).displayName).toBe("Acme");
  });

  it("de-duplicates labels case-insensitively, keeping the first spelling", () => {
    expect(uniqueLabels([" Team ", "team", "", "Family"])).toEqual(["Team", "Family"]);
  });
});
