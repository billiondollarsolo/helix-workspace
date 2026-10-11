import { describe, expect, it } from "vitest";
import {
  activeMentionQuery,
  applyFormat,
  chatBodyFormat,
  insertMention,
  mentionHandle,
  mentionSuggestions,
} from "./composer-text";
import type { ChatMemberView } from "./view-model";

const members: readonly ChatMemberView[] = [
  { actorId: "me", name: "Maya Chen", email: "maya@example.com", role: "owner" },
  { actorId: "dan", name: "Daniel Cho", email: "daniel@example.com", role: "member" },
  { actorId: "zoe", name: "Zoë Brandt", email: null, role: "member" },
  { actorId: "ed", name: "Ed Ruiz", email: "ed+chat@example.com", role: "member" },
];

describe("mentions", () => {
  it("uses the handle the server resolves: email local part, else the dotted name", () => {
    expect(mentionHandle({ name: "Daniel Cho", email: "daniel@example.com" })).toBe("daniel");
    expect(mentionHandle({ name: "Ed Ruiz", email: "ed+chat@example.com" })).toBe("ed.ruiz");
    expect(mentionHandle({ name: "Zoë Brandt", email: null })).toBeNull();
  });

  it("detects an @query at the caret but not inside an email address", () => {
    expect(activeMentionQuery("Hi @da", 6)).toEqual({ start: 3, query: "da" });
    expect(activeMentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(activeMentionQuery("mail dan@example", 16)).toBeNull();
    expect(activeMentionQuery("Hi @dan and more", 16)).toBeNull();
  });

  it("suggests other members who can be mentioned", () => {
    expect(mentionSuggestions(members, "d", "me").map((m) => m.actorId)).toEqual(["dan"]);
    expect(mentionSuggestions(members, "", "me").map((m) => m.actorId)).toEqual(["dan", "ed"]);
    expect(mentionSuggestions(members, "ruiz", "me").map((m) => m.actorId)).toEqual(["ed"]);
  });

  it("replaces the query with the handle and moves the caret past it", () => {
    expect(insertMention("Hi @da!", 3, 6, "daniel")).toEqual({
      text: "Hi @daniel !",
      selectionStart: 11,
      selectionEnd: 11,
    });
  });
});

describe("formatting", () => {
  it("wraps the selection in Markdown markers and keeps it selected", () => {
    const edit = { text: "make this bold", selectionStart: 10, selectionEnd: 14 };
    expect(applyFormat(edit, "bold")).toEqual({
      text: "make this **bold**",
      selectionStart: 12,
      selectionEnd: 16,
    });
    expect(applyFormat(edit, "strikethrough").text).toBe("make this ~~bold~~");
    expect(applyFormat(edit, "code").text).toBe("make this `bold`");
  });

  it("selects the URL of a new link and bullets the selected lines", () => {
    const link = applyFormat({ text: "docs", selectionStart: 0, selectionEnd: 4 }, "link");
    expect(link.text).toBe("[docs](https://)");
    expect(link.text.slice(link.selectionStart, link.selectionEnd)).toBe("https://");
    expect(applyFormat({ text: "one\ntwo", selectionStart: 0, selectionEnd: 7 }, "list").text).toBe(
      "- one\n- two",
    );
  });

  it("sends Markdown only when the body uses rendered syntax", () => {
    expect(chatBodyFormat("plain words, 3 * 4")).toBe("plain");
    expect(chatBodyFormat("email me@example.com")).toBe("plain");
    for (const body of ["**bold**", "*em*", "~~no~~", "`x`", "[a](https://x.test)", "- item"]) {
      expect(chatBodyFormat(body)).toBe("markdown");
    }
  });
});
