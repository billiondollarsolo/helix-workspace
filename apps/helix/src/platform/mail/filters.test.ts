import { describe, expect, it, vi } from "vitest";
import { hasFilterAction } from "./filter-actions.js";
import { evaluateInboundMail } from "./filters.js";
import type { MailStore } from "./store.js";
import type { MailFilterActions, MailFilterRecord, MailMessageInput } from "./types.js";

const orgId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const now = new Date("2026-10-11T09:00:00.000Z");

function filter(actions: MailFilterActions, enabled = true): MailFilterRecord {
  return {
    id: "filter-1",
    orgId,
    actorId,
    name: "From Ada",
    enabled,
    priority: 100,
    criteria: { fromContains: "ada@" },
    actions,
    createdAt: now,
    updatedAt: now,
  };
}

function storeWith(filters: readonly MailFilterRecord[]) {
  const updateThreadState = vi.fn<MailStore["updateThreadState"]>().mockResolvedValue(undefined);
  const store = {
    listFilters: vi.fn().mockResolvedValue(filters),
    updateThreadState,
    getActiveVacation: vi.fn().mockResolvedValue(null),
  } as unknown as MailStore;
  return { store, updateThreadState };
}

const message = {
  orgId,
  from: { address: "ada@example.net" },
  to: [{ address: "alice@example.com" }],
  subject: "Weekly report",
  bodyText: "Numbers attached.",
} as unknown as MailMessageInput;

async function evaluate(store: MailStore) {
  return evaluateInboundMail(store, {
    message,
    stored: { threadId: "thread-1", messageId: "message-1" },
    recipientActorId: actorId,
    recipientAddress: "alice@example.com",
    suppressAutoReply: true,
    now,
  });
}

describe("evaluateInboundMail", () => {
  it("marks matching mail read and starred", async () => {
    const { store, updateThreadState } = storeWith([filter({ markRead: true, star: true })]);

    await expect(evaluate(store)).resolves.toEqual({
      matchedFilterIds: ["filter-1"],
      vacationQueued: false,
    });
    expect(updateThreadState).toHaveBeenCalledWith({
      orgId,
      actorId,
      threadId: "thread-1",
      patch: { addLabels: [], readAt: now, starred: true },
    });
  });

  it("combines labels with skip-the-inbox and leaves unset actions alone", async () => {
    const { store, updateThreadState } = storeWith([
      filter({ applyLabels: ["reports"], archive: true }),
    ]);

    await evaluate(store);

    expect(updateThreadState.mock.calls[0]?.[0].patch).toEqual({
      addLabels: ["reports"],
      archivedAt: now,
    });
  });

  it("skips disabled filters", async () => {
    const { store, updateThreadState } = storeWith([filter({ star: true }, false)]);

    await expect(evaluate(store)).resolves.toMatchObject({ matchedFilterIds: [] });
    expect(updateThreadState).not.toHaveBeenCalled();
  });
});

describe("hasFilterAction", () => {
  it("counts mark-as-read and star as actions", () => {
    expect(hasFilterAction({ markRead: true })).toBe(true);
    expect(hasFilterAction({ star: true })).toBe(true);
    expect(hasFilterAction({ markRead: false, star: false, applyLabels: [] })).toBe(false);
  });
});
