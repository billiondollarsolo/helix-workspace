import { describe, expect, it, vi } from "vitest";
import type { CalendarInvitationSender } from "./ics.js";
import {
  CalendarInvitationDeliveryWorker,
  type ClaimedCalendarInvitationDelivery,
  type PostgresCalendarInvitationDeliveryStore,
} from "./invitation-outbox.js";

describe("CalendarInvitationDeliveryWorker", () => {
  it("does not queue a second mail after crashing between queue and completion", async () => {
    const delivery = claimedDelivery();
    let claimed = 0;
    let existing: string | null = null;
    async function withActorContext<T>(
      _input: { readonly orgId: string; readonly actorId: string },
      callback: () => Promise<T>,
    ): Promise<T> {
      return callback();
    }
    const store = {
      withActorContext,
      claim: vi.fn(() => Promise.resolve(claimed++ < 2 ? [delivery] : [])),
      prepare: vi.fn(() => Promise.resolve(true)),
      findMailOutbound: vi.fn(() => Promise.resolve(existing)),
      complete: vi
        .fn()
        .mockRejectedValueOnce(new Error("crash after durable mail queue"))
        .mockResolvedValue(true),
      fail: vi.fn(() => Promise.resolve(true)),
    } satisfies Pick<
      PostgresCalendarInvitationDeliveryStore,
      "claim" | "complete" | "fail" | "findMailOutbound" | "prepare" | "withActorContext"
    >;
    const sender = {
      sendInvitation: vi.fn(() => {
        existing = "mail-outbound-1";
        return Promise.resolve([{ id: existing }] as never);
      }),
    } satisfies CalendarInvitationSender;
    const worker = new CalendarInvitationDeliveryWorker({ store, sender });

    await worker.drainOnce();
    await worker.drainOnce();

    expect(sender.sendInvitation).toHaveBeenCalledOnce();
    expect(store.fail).toHaveBeenCalledOnce();
    expect(store.complete).toHaveBeenLastCalledWith({
      id: delivery.id,
      leaseToken: delivery.leaseToken,
      mailOutboundId: "mail-outbound-1",
    });
    expect(sender.sendInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: delivery.id, method: "REQUEST" }),
    );
  });

  it("does not hand off a claimed delivery after its event revision becomes stale", async () => {
    const delivery = claimedDelivery();
    async function withActorContext<T>(
      _input: { readonly orgId: string; readonly actorId: string },
      callback: () => Promise<T>,
    ): Promise<T> {
      return callback();
    }
    const store = {
      withActorContext,
      claim: vi.fn(() => Promise.resolve([delivery])),
      prepare: vi.fn(() => Promise.resolve(false)),
      findMailOutbound: vi.fn(() => Promise.resolve(null)),
      complete: vi.fn(() => Promise.resolve(true)),
      fail: vi.fn(() => Promise.resolve(true)),
    } satisfies Pick<
      PostgresCalendarInvitationDeliveryStore,
      "claim" | "complete" | "fail" | "findMailOutbound" | "prepare" | "withActorContext"
    >;
    const sender = { sendInvitation: vi.fn() } satisfies CalendarInvitationSender;

    await new CalendarInvitationDeliveryWorker({ store, sender }).drainOnce();

    expect(sender.sendInvitation).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.fail).not.toHaveBeenCalled();
  });
});

function claimedDelivery(): ClaimedCalendarInvitationDelivery {
  return {
    id: "c0800000-0000-4000-8000-000000000001",
    orgId: "c0800000-0000-4000-8000-000000000002",
    actorId: "c0800000-0000-4000-8000-000000000003",
    eventId: "c0800000-0000-4000-8000-000000000004",
    eventRevision: 1,
    recipient: "guest@example.test",
    method: "REQUEST",
    attemptCount: 1,
    leaseToken: "c0800000-0000-4000-8000-000000000005",
    event: {
      id: "c0800000-0000-4000-8000-000000000004",
      orgId: "c0800000-0000-4000-8000-000000000002",
      calendarId: "c0800000-0000-4000-8000-000000000006",
      title: "Durable invite",
      startsAt: new Date("2026-09-03T12:00:00Z"),
      endsAt: new Date("2026-09-03T13:00:00Z"),
      allDay: false,
      status: "confirmed",
      icsSequence: 1,
      metadata: {},
      deletedAt: null,
      createdAt: new Date("2026-09-02T12:00:00Z"),
      updatedAt: new Date("2026-09-02T12:00:00Z"),
      attendees: [
        {
          actorId: null,
          email: "guest@example.test",
          responseStatus: "needs_action",
          isOrganizer: false,
        },
      ],
    },
  };
}
