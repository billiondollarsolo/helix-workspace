import { describe, expect, it, vi } from "vitest";
import { createCalendarEvent } from "../calendar/api";
import { listChatMentions, listChatUnread } from "../chat/api";
import {
  changeAccountPassword,
  createMyAppPassword,
  getAccountPreferences,
  listAccountSessions,
  listMyAppPasswords,
  revokeAccountSession,
  revokeMyAppPassword,
  revokeOtherAccountSessions,
  setAccountPreferences,
} from "./api";

function jsonFetch(output: unknown, status = 200) {
  return vi.fn<typeof fetch>(() => Promise.resolve(Response.json(output, { status })));
}

const session = {
  id: "session-1",
  current: true,
  createdAt: "2026-10-01T00:00:00.000Z",
  lastActiveAt: "2026-10-11T00:00:00.000Z",
  expiresAt: "2027-01-01T00:00:00.000Z",
  ipAddress: null,
  userAgent: null,
  browser: "Chrome",
  os: "macOS",
  deviceType: "desktop",
};

describe("account API", () => {
  it("reads and updates preferences through the account tools", async () => {
    const fetchImpl = jsonFetch({ timeZone: "Europe/Paris" });
    await getAccountPreferences(fetchImpl);
    await setAccountPreferences({ detectedTimeZone: "Europe/Paris", weekStart: 1 }, fetchImpl);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/api/tools/account.preferences.get",
      "/api/tools/account.preferences.set",
    ]);
  });

  it("lists and signs out sessions and changes the password over the account routes", async () => {
    const fetchImpl = jsonFetch({ sessions: [session], revoked: 2, changed: true });
    await expect(listAccountSessions(fetchImpl)).resolves.toEqual([session]);
    await revokeAccountSession("session/1", fetchImpl);
    await expect(revokeOtherAccountSessions(fetchImpl)).resolves.toBe(2);
    await changeAccountPassword(
      { currentPassword: "old", newPassword: "new-password", revokeOtherSessions: true },
      fetchImpl,
    );
    expect(
      fetchImpl.mock.calls.map(([url, init]) => `${init?.method ?? ""} ${url as string}`),
    ).toEqual([
      "GET /api/account/sessions",
      "POST /api/account/sessions/session%2F1/revoke",
      "POST /api/account/sessions/revoke-others",
      "POST /api/account/password",
    ]);
  });

  it("surfaces the server's message when a password change fails", async () => {
    const fetchImpl = jsonFetch(
      { error: { code: "bad_request", message: "Your current password is incorrect." } },
      400,
    );
    await expect(
      changeAccountPassword({ currentPassword: "x", newPassword: "long-enough" }, fetchImpl),
    ).rejects.toThrow("Your current password is incorrect.");
  });

  it("manages your own app passwords", async () => {
    const fetchImpl = jsonFetch({ appPasswords: [], status: "revoked" });
    await expect(listMyAppPasswords({ actorId: "actor-1" }, fetchImpl)).resolves.toEqual([]);
    await createMyAppPassword({ label: "Phone", scopes: ["caldav"] }, fetchImpl);
    await revokeMyAppPassword("password-1", fetchImpl);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/api/tools/app.passwords.list",
      "/api/tools/app.passwords.create",
      "/api/tools/app.passwords.revoke",
    ]);
  });
});

describe("chat Home and calendar conferencing wrappers", () => {
  it("calls the unread, mentions and event-create tools", async () => {
    const fetchImpl = jsonFetch({ rooms: [], totalUnread: 0, totalMentions: 0, mentions: [] });
    await listChatUnread(fetchImpl);
    await listChatMentions({ before: "2026-10-01T00:00:00.000Z" }, fetchImpl);
    await createCalendarEvent(
      {
        title: "Review",
        startsAt: "2026-10-12T09:00:00.000Z",
        endsAt: "2026-10-12T09:30:00.000Z",
        conference: "meet",
      },
      fetchImpl,
    );
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/api/tools/chat.unread.list",
      "/api/tools/chat.mentions.list",
      "/api/tools/calendar.event.create",
    ]);
    expect(JSON.parse(fetchImpl.mock.calls[2]?.[1]?.body as string)).toMatchObject({
      conference: "meet",
    });
  });
});
