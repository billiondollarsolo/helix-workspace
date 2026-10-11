import { describe, expect, it } from "vitest";
import { contact } from "./contacts-test-server";
import {
  draftErrors,
  draftFromContact,
  emptyAddress,
  fieldsFromDraft,
  formatBirthday,
  hasDraftErrors,
  listName,
  matchesContactQuery,
  patchFromDraft,
  sectionLetter,
  sortContacts,
} from "./model";

const ada = contact({ displayName: "Ada Lovelace", givenName: "Ada", familyName: "Lovelace" });
const grace = contact({ displayName: "Grace Hopper", givenName: "Grace", familyName: "Hopper" });
const acme = contact({ displayName: "Acme", company: "Acme" });
const emoji = contact({
  displayName: "Émile Zola",
  givenName: "Émile",
  familyName: "Zola",
  phones: [{ type: "mobile", value: "+33 1 23 45 67 89" }],
});

describe("contact list model", () => {
  it("sorts by first or last name and files names under A–Z sections", () => {
    expect(
      sortContacts([grace, emoji, ada, acme], "first").map((entry) => entry.displayName),
    ).toEqual(["Acme", "Ada Lovelace", "Émile Zola", "Grace Hopper"]);
    expect(
      sortContacts([grace, emoji, ada, acme], "last").map((entry) => entry.displayName),
    ).toEqual(["Acme", "Grace Hopper", "Ada Lovelace", "Émile Zola"]);
    expect(sectionLetter(emoji, "first")).toBe("E");
    expect(sectionLetter(contact({ displayName: "+1 555" }), "first")).toBe("#");
    expect(listName(ada, "last")).toBe("Lovelace, Ada");
    expect(listName(acme, "last")).toBe("Acme");
  });

  it("matches names, companies and phone digits", () => {
    expect(matchesContactQuery(ada, "love")).toBe(true);
    expect(matchesContactQuery(acme, "acm")).toBe(true);
    expect(matchesContactQuery(emoji, "2345")).toBe(true);
    expect(matchesContactQuery(emoji, "hopper")).toBe(false);
  });

  it("formats birthdays with and without a year", () => {
    expect(formatBirthday("1815-12-10")).toMatch(/1815/u);
    expect(formatBirthday("--12-10")).not.toMatch(/\d{4}/u);
  });
});

describe("contact form draft", () => {
  it("drops blank rows and trims what it saves", () => {
    const draft = draftFromContact(null);
    draft.givenName = "  Ada ";
    draft.emails[0] = { ...draft.emails[0]!, value: " ada@example.com " };
    draft.addresses.push(emptyAddress());
    expect(fieldsFromDraft(draft)).toMatchObject({
      givenName: "Ada",
      emails: [{ type: "home", value: "ada@example.com" }],
      phones: [],
      addresses: [],
    });
  });

  it("reports invalid rows by key and requires some identity", () => {
    const draft = draftFromContact(null);
    expect(draftErrors(draft).form).toBe("Add a name, company, email or phone.");
    draft.emails[0] = { ...draft.emails[0]!, value: "not-an-address" };
    const errors = draftErrors(draft);
    expect(errors.entries[draft.emails[0].key]).toBe("Enter a valid email address.");
    expect(hasDraftErrors(errors)).toBe(true);
  });

  it("sends only the fields an edit changed", () => {
    const stored = contact({
      displayName: "Ada Lovelace",
      givenName: "Ada",
      familyName: "Lovelace",
      emails: [{ type: "work", value: "ada@example.com" }],
      labels: ["Family"],
    });
    const draft = draftFromContact(stored);
    draft.jobTitle = "Mathematician";
    draft.labels = ["Family", "Science"];
    expect(patchFromDraft(stored, draft)).toEqual({
      jobTitle: "Mathematician",
      labels: ["Family", "Science"],
    });
  });
});
