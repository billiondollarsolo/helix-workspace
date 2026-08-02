import { describe, expect, it } from "vitest";
import {
  isMailSendTerminalPhase,
  mailSendStatusLabel,
  mailSendUiStatusIsRetryable,
  mailSendUiStatusLabel,
  mapMailSendUiStatus,
  resolveMailDeliveryStatus,
  resolveMailSendUiStatus,
  shouldPollMailSendStatus,
} from "./mail-send-status";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const UNDO_FUTURE = "2026-08-02T12:00:30.000Z";
const UNDO_PAST = "2026-08-02T11:59:50.000Z";

describe("resolveMailSendUiStatus (M10 slim)", () => {
  it("maps backend statuses including delayed and undo window", () => {
    expect(resolveMailSendUiStatus({ status: "queued" })).toBe("queued");
    expect(resolveMailSendUiStatus({ status: "sending" })).toBe("sending");
    expect(resolveMailSendUiStatus({ status: "sent" })).toBe("sent");
    expect(resolveMailSendUiStatus({ status: "failed" })).toBe("failed");
    expect(resolveMailSendUiStatus({ status: "cancelled" })).toBe("cancelled");
    expect(
      resolveMailSendUiStatus({
        status: "sent",
        deliveryMetadata: { latestEvent: "delayed" },
      }),
    ).toBe("delayed");
    expect(
      resolveMailSendUiStatus({
        status: "queued",
        undoUntil: new Date(Date.now() + 60_000).toISOString(),
        nowMs: Date.now(),
      }),
    ).toBe("undo_window");
  });

  it("returns null for unknown/empty status (negative)", () => {
    expect(resolveMailSendUiStatus({ status: null })).toBeNull();
    expect(resolveMailSendUiStatus({ status: "mystery" })).toBeNull();
  });

  it("labels statuses and marks failed/delayed retryable", () => {
    expect(mailSendUiStatusLabel("failed")).toBe("Failed");
    expect(mailSendUiStatusIsRetryable("failed")).toBe(true);
    expect(mailSendUiStatusIsRetryable("sent")).toBe(false);
  });
});

describe("mapMailSendUiStatus (M10 compose machine)", () => {
  it("maps a mail.send result during the undo window to queued + undo", () => {
    // Shape matches serializeOutbound from mail tools.
    const ui = mapMailSendUiStatus(
      {
        id: "outbound-1",
        status: "queued",
        deliveryStatus: "queued",
        undoUntil: UNDO_FUTURE,
      },
      NOW,
    );

    expect(ui.phase).toBe("queued");
    expect(ui.undoAvailable).toBe(true);
    expect(ui.outboundId).toBe("outbound-1");
    expect(ui.label).toBe(mailSendStatusLabel("queued", { undoAvailable: true }));
    expect(shouldPollMailSendStatus(ui.phase)).toBe(true);
    expect(isMailSendTerminalPhase(ui.phase)).toBe(false);
  });

  it("maps queued after undo window expires without inventing sent", () => {
    const ui = mapMailSendUiStatus(
      {
        id: "outbound-2",
        status: "queued",
        deliveryStatus: "queued",
        undoUntil: UNDO_PAST,
      },
      NOW,
    );
    expect(ui.phase).toBe("queued");
    expect(ui.undoAvailable).toBe(false);
    expect(ui.label).toBe(mailSendStatusLabel("queued", { undoAvailable: false }));
  });

  it("prefers deliveryStatus delayed over raw status sent", () => {
    expect(
      resolveMailDeliveryStatus({
        status: "sent",
        deliveryStatus: "delayed",
      }),
    ).toBe("delayed");

    const ui = mapMailSendUiStatus(
      {
        id: "outbound-3",
        status: "sent",
        deliveryStatus: "delayed",
        undoUntil: UNDO_PAST,
      },
      NOW,
    );
    expect(ui.phase).toBe("delayed");
    expect(shouldPollMailSendStatus(ui.phase)).toBe(true);
  });

  it("derives delayed from deliveryMetadata when deliveryStatus is absent", () => {
    const ui = mapMailSendUiStatus(
      {
        id: "outbound-4",
        status: "sent",
        deliveryMetadata: { latestEvent: "soft_bounce" },
      },
      NOW,
    );
    expect(ui.phase).toBe("delayed");
  });

  it.each([
    ["sending", "sending"],
    ["sent", "sent"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ] as const)("maps outbound status %s via the real mapper to %s", (status, expected) => {
    const ui = mapMailSendUiStatus(
      {
        outboundId: "outbound-x",
        status,
        deliveryStatus: status,
        undoUntil: UNDO_PAST,
        lastError: status === "failed" ? "provider rejected" : null,
      },
      NOW,
    );
    expect(ui.phase).toBe(expected);
    expect(ui.undoAvailable).toBe(false);
    expect(isMailSendTerminalPhase(ui.phase)).toBe(
      expected === "sent" || expected === "failed" || expected === "cancelled",
    );
    if (expected === "failed") {
      expect(ui.label).toContain("provider rejected");
    } else {
      expect(ui.label).toBe(mailSendStatusLabel(expected));
    }
  });

  it("uses clientPhase submitting before an outbound record exists", () => {
    const ui = mapMailSendUiStatus({ clientPhase: "submitting" }, NOW);
    expect(ui.phase).toBe("submitting");
    expect(ui.label).toBe("Sending…");
    expect(shouldPollMailSendStatus(ui.phase)).toBe(false);
  });

  it("maps client submit errors to failed without faking a delivery status", () => {
    const ui = mapMailSendUiStatus(
      { clientPhase: "error", lastError: "network offline" },
      NOW,
    );
    expect(ui.phase).toBe("failed");
    expect(ui.label).toContain("network offline");
  });

  it("does not treat unknown status strings as sent", () => {
    const ui = mapMailSendUiStatus(
      { id: "o1", status: "mystery", deliveryStatus: "not-a-status" },
      NOW,
    );
    expect(ui.phase).toBe("idle");
    expect(ui.outboundId).toBe("o1");
  });

  it("requires outbound id for undo even when undoUntil is in the future", () => {
    const ui = mapMailSendUiStatus(
      {
        status: "queued",
        deliveryStatus: "queued",
        undoUntil: UNDO_FUTURE,
      },
      NOW,
    );
    expect(ui.phase).toBe("queued");
    expect(ui.undoAvailable).toBe(false);
    expect(ui.outboundId).toBeNull();
  });
});
