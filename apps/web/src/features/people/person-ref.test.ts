import { describe, expect, it } from "vitest";
import {
  calendarCreateHandoffFromSearch,
  chatDirectMessageHandoffFromSearch,
  mailComposeHandoffFromSearch,
} from "./handoff";
import {
  externalPersonRef,
  isPersonRefValid,
  isValidEmailAddress,
  parseAddressList,
  personRefAddress,
  personRefFromDirectory,
  personRefKey,
} from "./person-ref";

const actorId = "00000000-0000-4000-8000-000000000111";

describe("PersonRef", () => {
  it("resolves directory rows to members, groups and external contacts", () => {
    const base = {
      email: "sam@helix.test",
      displayName: "Sam Patel",
      title: "Engineer",
      favorite: false,
      avatarDataUrl: null,
      relationship: {},
    };
    expect(
      personRefFromDirectory({ ...base, id: "contact-1", kind: "personal", actorId }),
    ).toMatchObject({ kind: "member", actorId, groupId: null, email: "sam@helix.test" });
    expect(
      personRefFromDirectory({ ...base, id: "group-1", kind: "group", actorId: null }),
    ).toMatchObject({ kind: "group", actorId: null, groupId: "group-1" });
    expect(
      personRefFromDirectory({ ...base, id: "contact-2", kind: "personal", actorId: null }),
    ).toMatchObject({ kind: "external", actorId: null, groupId: null });
  });

  it("parses named addresses and pasted lists", () => {
    expect(externalPersonRef("Ada Lovelace <ada@example.com>")).toMatchObject({
      displayName: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(
      parseAddressList("ada@example.com, Bo <bo@example.org>;\nnot-an-email").map(
        (ref) => ref.email,
      ),
    ).toEqual(["ada@example.com", "bo@example.org", "not-an-email"]);
  });

  it("validates external addresses only when external recipients are allowed", () => {
    const external = externalPersonRef("ada@example.com");
    expect(isValidEmailAddress("ada@example.com")).toBe(true);
    expect(isValidEmailAddress("ada@example")).toBe(false);
    expect(isPersonRefValid(external)).toBe(false);
    expect(isPersonRefValid(external, { allowExternal: true })).toBe(true);
    expect(isPersonRefValid(externalPersonRef("ada"), { allowExternal: true })).toBe(false);
  });

  it("keys refs by identity and formats the full address", () => {
    const ref = externalPersonRef("Ada <ADA@example.com>");
    expect(personRefKey(ref)).toBe("email:ada@example.com");
    expect(personRefAddress(ref)).toBe("Ada <ADA@example.com>");
  });
});

describe("person handoff params", () => {
  it("keeps only valid prefilled intents", () => {
    expect(mailComposeHandoffFromSearch({ compose: "new", to: "a@x.io, nope ,b@y.org" })).toEqual({
      compose: "new",
      to: "a@x.io,b@y.org",
    });
    expect(mailComposeHandoffFromSearch({ compose: "reply", to: "nope" })).toEqual({});
    expect(chatDirectMessageHandoffFromSearch({ dm: actorId })).toEqual({ dm: actorId });
    expect(chatDirectMessageHandoffFromSearch({ dm: "not-a-uuid" })).toEqual({});
    expect(calendarCreateHandoffFromSearch({ create: "event", attendees: "a@x.io" })).toEqual({
      create: "event",
      attendees: "a@x.io",
    });
  });
});
