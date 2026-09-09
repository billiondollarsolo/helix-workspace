// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  MAIL_COMPOSE_RECOVERY_KEY,
  clearMailComposeRecovery,
  hasMailComposeContent,
  invalidRecipientTokens,
  readMailComposeRecovery,
  recipientTokens,
  reconcileMailComposeDrafts,
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

  it("reconciles local recovery against server drafts without silent overwrite", () => {
    const local = {
      to: [{ address: "mira@helix.test" }],
      cc: [],
      bcc: [],
      subject: "Local",
      bodyText: "from local",
      attachments: [],
      updatedAt: "2026-08-01T12:00:00.000Z",
    };
    expect(reconcileMailComposeDrafts({ local: null, server: null })).toEqual({ action: "empty" });
    expect(
      reconcileMailComposeDrafts({
        local,
        server: null,
      }),
    ).toEqual({ action: "use-local", local });
    expect(
      reconcileMailComposeDrafts({
        local,
        server: {
          to: local.to,
          cc: [],
          bcc: [],
          attachments: [],
          subject: local.subject,
          bodyText: local.bodyText,
          updatedAt: "2026-08-01T13:00:00.000Z",
        },
      }),
    ).toEqual({ action: "use-server", clearLocal: true });
    expect(
      reconcileMailComposeDrafts({
        local,
        server: {
          to: [{ address: "other@helix.test" }],
          cc: [],
          bcc: [],
          attachments: [],
          subject: "Server",
          bodyText: "from server",
          updatedAt: "2026-08-01T11:00:00.000Z",
        },
      }).action,
    ).toBe("conflict");
  });
});
