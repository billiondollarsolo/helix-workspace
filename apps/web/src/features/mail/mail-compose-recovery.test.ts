// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  MAIL_COMPOSE_RECOVERY_KEY,
  clearMailComposeRecovery,
  hasMailComposeContent,
  invalidRecipientTokens,
  readMailComposeRecovery,
  recipientTokens,
  writeMailComposeRecovery,
} from "./mail-compose-recovery";

describe("mail compose recovery", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips a bounded local draft and clears it explicitly", () => {
    writeMailComposeRecovery({
      to: [{ address: "mira@helix.test" }],
      cc: [],
      bcc: [],
      subject: "Launch",
      bodyText: "Recovered body",
      attachments: [{ objectId: "11111111-1111-4111-8111-111111111111", filename: "brief.pdf" }],
    });
    expect(readMailComposeRecovery()).toMatchObject({
      to: [{ address: "mira@helix.test" }],
      subject: "Launch",
      bodyText: "Recovered body",
      attachments: [{ objectId: "11111111-1111-4111-8111-111111111111" }],
    });

    clearMailComposeRecovery();
    expect(window.localStorage.getItem(MAIL_COMPOSE_RECOVERY_KEY)).toBeNull();
  });

  it("rejects expired or malformed records", () => {
    window.localStorage.setItem(
      MAIL_COMPOSE_RECOVERY_KEY,
      JSON.stringify({
        to: [{ address: "mira@helix.test" }],
        cc: [],
        bcc: [],
        subject: "Old",
        bodyText: "Old",
        attachments: [],
        updatedAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    expect(readMailComposeRecovery(window.localStorage, Date.parse("2026-07-28"))).toBeNull();
    expect(window.localStorage.getItem(MAIL_COMPOSE_RECOVERY_KEY)).toBeNull();
  });

  it("parses recipient lists and reports invalid addresses", () => {
    expect(recipientTokens("mira@helix.test; alex@helix.test")).toEqual([
      "mira@helix.test",
      "alex@helix.test",
    ]);
    expect(invalidRecipientTokens("mira@helix.test, wrong, @broken")).toEqual(["wrong", "@broken"]);
    expect(
      hasMailComposeContent({
        to: [],
        cc: [],
        bcc: [],
        subject: "",
        bodyText: "Draft",
        attachments: [],
      }),
    ).toBe(true);
  });
});
