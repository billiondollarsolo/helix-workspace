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
      to: "mira@helix.test",
      cc: "",
      bcc: "",
      subject: "Launch",
      body: "Recovered body",
    });
    expect(readMailComposeRecovery()).toMatchObject({
      to: "mira@helix.test",
      subject: "Launch",
      body: "Recovered body",
    });

    clearMailComposeRecovery();
    expect(window.localStorage.getItem(MAIL_COMPOSE_RECOVERY_KEY)).toBeNull();
  });

  it("rejects expired or malformed records", () => {
    window.localStorage.setItem(
      MAIL_COMPOSE_RECOVERY_KEY,
      JSON.stringify({
        to: "mira@helix.test",
        cc: "",
        bcc: "",
        subject: "Old",
        body: "Old",
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
    expect(hasMailComposeContent({ to: "", cc: "", bcc: "", subject: "", body: "Draft" })).toBe(
      true,
    );
  });

  it("reconciles local recovery against server drafts without silent overwrite", () => {
    const local = {
      to: "mira@helix.test",
      cc: "",
      bcc: "",
      subject: "Local",
      body: "from local",
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
          cc: "",
          bcc: "",
          subject: local.subject,
          body: local.body,
          updatedAt: "2026-08-01T13:00:00.000Z",
        },
      }),
    ).toEqual({ action: "use-server", clearLocal: true });
    expect(
      reconcileMailComposeDrafts({
        local,
        server: {
          to: "other@helix.test",
          cc: "",
          bcc: "",
          subject: "Server",
          body: "from server",
          updatedAt: "2026-08-01T11:00:00.000Z",
        },
      }).action,
    ).toBe("conflict");
  });
});
