import { describe, expect, it } from "vitest";
import { createRecordingSql } from "../../test-support/recording-sql.js";
import { FILTER_ACTION_REQUIRED } from "./filter-actions.js";
import type { MailStore } from "./store.js";
import { MailPreferencesStore } from "./store-preferences.js";
import { createMailToolDefinitions } from "./tools.js";
import type { MailUserSettings } from "./types.js";
import {
  applyMailUserSettingsPatch,
  type SetMailUserSettingsInput,
} from "./user-settings-input.js";

const ctx = { actor: { id: "a1", orgId: "o1" } } as never;

function settingsTools(initial: MailUserSettings) {
  let saved = initial;
  const calls: SetMailUserSettingsInput[] = [];
  const store = {
    getUserSettings: async () => saved,
    setUserSettings: async (input: SetMailUserSettingsInput) => {
      calls.push(input);
      saved = applyMailUserSettingsPatch(saved, input, new Date("2026-10-10T00:00:00.000Z"));
      return saved;
    },
  } as unknown as MailStore;
  const tools = createMailToolDefinitions({ store });
  const tool = (id: string) => {
    const found = tools.find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`tool ${id} not registered`);
    return found;
  };
  return { tool, calls };
}

const stored: MailUserSettings = {
  signatureText: "Old",
  signatureHtml: "<b>Old</b>",
  includeSignatureOnReplies: false,
  blockedSenders: ["spam@example.net"],
  updatedAt: new Date("2026-10-01T00:00:00.000Z"),
};

describe("mail.settings.set partial updates", () => {
  it("keeps blocked senders and other fields when only signatureText is sent", async () => {
    const { tool, calls } = settingsTools(stored);
    const set = tool("mail.settings.set");
    const output = await set.handler(set.inputSchema.parse({ signatureText: "  New  " }), ctx);

    expect(calls[0]).toEqual({ orgId: "o1", actorId: "a1", signatureText: "New" });
    expect(output).toMatchObject({
      signatureText: "New",
      signatureHtml: "<b>Old</b>",
      includeSignatureOnReplies: false,
      blockedSenders: ["spam@example.net"],
    });
  });

  it("clears signatureHtml only when null is sent explicitly", async () => {
    const { tool } = settingsTools(stored);
    const set = tool("mail.settings.set");
    await expect(
      set.handler(set.inputSchema.parse({ signatureHtml: null }), ctx),
    ).resolves.toMatchObject({ signatureHtml: null, signatureText: "Old" });
  });

  it("rejects an empty update with an actionable message", () => {
    const { tool } = settingsTools(stored);
    expect(() => tool("mail.settings.set").inputSchema.parse({})).toThrow(
      /Provide at least one of signatureText/u,
    );
  });

  it("upserts only submitted columns in one statement", async () => {
    const recording = createRecordingSql([
      [
        {
          signature_text: "New",
          signature_html: null,
          include_signature_on_replies: true,
          blocked_senders: ["spam@example.net"],
          updated_at: new Date(),
        },
      ],
    ]);
    await new MailPreferencesStore(recording.sql).setUserSettings({
      orgId: "o1",
      actorId: "a1",
      signatureText: "New",
    });
    const text = recording.calls[0]?.text.replace(/\s+/gu, " ") ?? "";
    expect(text).toContain(
      "blocked_senders = case when ?::boolean then excluded.blocked_senders else mail_user_settings.blocked_senders end",
    );
    // signatureText provided; html, reply flag, and blocked senders omitted.
    expect(recording.calls[0]?.values.slice(-4)).toEqual([true, false, false, false]);
  });
});

describe("mail.filter.create actions", () => {
  it("rejects a filter without any action", () => {
    const { tool } = settingsTools(stored);
    const create = tool("mail.filter.create");
    for (const actions of [undefined, {}, { archive: false, applyLabels: [] }]) {
      expect(() =>
        create.inputSchema.parse({ name: "From a", criteria: { fromContains: "a" }, actions }),
      ).toThrow(FILTER_ACTION_REQUIRED);
    }
    for (const actions of [{ archive: true }, { markRead: true }, { star: true }]) {
      expect(() =>
        create.inputSchema.parse({ name: "From a", criteria: {}, actions }),
      ).not.toThrow();
    }
  });

  it("rejects clearing every action on update", () => {
    const { tool } = settingsTools(stored);
    expect(() =>
      tool("mail.filter.update").inputSchema.parse({
        id: "11111111-1111-4111-8111-111111111111",
        actions: {},
      }),
    ).toThrow(FILTER_ACTION_REQUIRED);
  });
});
