import { describe, expect, it } from "vitest";
import { CliUsageError } from "./cli-error.js";
import { parseCliArgs } from "./parser.js";
import { scopedUsage } from "./usage.js";

describe("workspace command wrappers", () => {
  it("maps mail label, scheduled, account and chat commands to their tools", () => {
    expect(parseCliArgs(["mail", "label-create", "--name", "Clients", "--color", "green"])).toEqual(
      {
        kind: "tool-call",
        toolId: "mail.label.create",
        json: { source: "inline", value: '{"name":"Clients","color":"green"}' },
      },
    );
    expect(parseCliArgs(["mail", "scheduled", "--limit", "5"])).toMatchObject({
      toolId: "mail.scheduled.list",
      json: { value: '{"limit":5}' },
    });
    expect(parseCliArgs(["account", "preferences-set", "--week-start", "1"])).toMatchObject({
      toolId: "account.preferences.set",
      json: { value: '{"weekStart":1}' },
    });
    expect(parseCliArgs(["account", "app-passwords", "--include-revoked"])).toMatchObject({
      toolId: "app.passwords.list",
      json: { value: '{"includeRevoked":true}' },
    });
    expect(parseCliArgs(["chat", "mentions", "--json", "{}"])).toEqual({
      kind: "tool-call",
      toolId: "chat.mentions.list",
      json: { source: "inline", value: "{}" },
    });
  });

  it("maps contacts commands to the contacts tools", () => {
    expect(
      parseCliArgs(["contacts", "create", "--given-name", "Ada", "--company", "Engines"]),
    ).toEqual({
      kind: "tool-call",
      toolId: "contacts.create",
      json: { source: "inline", value: '{"givenName":"Ada","company":"Engines"}' },
    });
    expect(parseCliArgs(["contacts", "list", "--label", "Family", "--limit", "20"])).toMatchObject({
      toolId: "contacts.list",
      json: { value: '{"label":"Family","limit":20}' },
    });
    expect(
      parseCliArgs(["contacts", "label-rename", "--name", "A", "--new-name", "B"]),
    ).toMatchObject({
      toolId: "contacts.label.rename",
      json: { value: '{"name":"A","newName":"B"}' },
    });
    expect(
      parseCliArgs([
        "contacts",
        "trash",
        "--json",
        '{"ids":["00000000-0000-4000-8000-000000000001"]}',
      ]),
    ).toMatchObject({ toolId: "contacts.trash", json: { source: "inline" } });
    expect(() => parseCliArgs(["contacts", "trash", "--id", "x"])).toThrow(
      "Usage: helix contacts trash --json",
    );
    expect(scopedUsage(["contacts"])).toContain("helix contacts directory");
  });

  it("rejects missing required flags and unknown flags with the command usage", () => {
    expect(() => parseCliArgs(["mail", "label-delete"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["chat", "unread", "--bogus", "1"])).toThrow(
      "Usage: helix chat unread",
    );
    expect(scopedUsage(["account"])).toContain("helix account app-password-revoke");
  });
});
