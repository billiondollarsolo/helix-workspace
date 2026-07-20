import { describe, expect, it, vi } from "vitest";
import {
  applyMailLabels,
  archiveMailThread,
  createMailFilter,
  deleteMailFilter,
  deleteMailThread,
  getMailVacation,
  getMailThread,
  listMailFilters,
  replyToMail,
  searchMail,
  sendMail,
  setMailVacation,
  setMailThreadRead,
  setMailThreadStarred,
  snoozeMailThread,
  spamMailThread,
  updateMailFilter,
} from "./api";
import {
  mailRouteSearchFromState,
  mailSearchInputFromRouteSearch,
  mailSearchStateFromRouteSearch,
  validateMailRouteSearch,
} from "./queries";

describe("mail API", () => {
  it("normalizes route search state into the mail.search query input", () => {
    const routeSearch = validateMailRouteSearch({
      thread: "thread-1",
      message: "message-1",
      q: "launch",
      label: "planning",
      mailbox: "starred",
      unread: "true",
      priority: "1",
      attachments: "false",
    });

    expect(routeSearch).toEqual({
      thread: "thread-1",
      message: "message-1",
      q: "launch",
      label: "planning",
      mailbox: "starred",
      unread: true,
      priority: true,
      attachments: undefined,
    });
    expect(mailSearchInputFromRouteSearch(routeSearch)).toEqual({
      query: "launch",
      labels: ["planning"],
      limit: 50,
    });
    expect(
      mailRouteSearchFromState(mailSearchStateFromRouteSearch(routeSearch), routeSearch),
    ).toEqual({
      thread: "thread-1",
      message: "message-1",
      q: "launch",
      label: "planning",
      mailbox: "starred",
      unread: true,
      priority: true,
      attachments: undefined,
    });
  });

  it("searches through the mail.search tool", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          hits: [
            {
              threadId: "thread-1",
              messageId: "message-1",
              subject: "Launch",
              preview: "Ready",
              sentAt: "2026-05-20T10:00:00.000Z",
              labels: ["planning"],
            },
          ],
        }),
      ),
    );

    await expect(
      searchMail({ query: "launch", labels: ["planning"] }, fetchImpl),
    ).resolves.toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/mail.search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "launch", labels: ["planning"], limit: 50 }),
    });
  });

  it("sends and replies with backend tool payloads", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({ status: "queued" })));
    const message = {
      to: [{ address: "sam@helix.local", name: "Sam Patel" }],
      cc: [],
      bcc: [],
      subject: "Hello",
      bodyText: "Body",
    };

    await expect(sendMail(message, fetchImpl)).resolves.toEqual({ status: "queued" });
    await expect(replyToMail({ ...message, threadId: "thread-1" }, fetchImpl)).resolves.toEqual({
      status: "queued",
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/mail.send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/tools/mail.reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "thread-1", ...message }),
    });
  });

  it("fetches a selected mail thread", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          thread: {
            id: "thread-1",
            subject: "Launch",
            preview: "Ready",
            participants: [],
            messages: [],
            labels: [],
            archivedAt: null,
            deletedAt: null,
            snoozedUntil: null,
            lastActivity: "2026-05-20T10:00:00.000Z",
            unread: false,
            starred: false,
            direction: "inbound",
          },
        }),
      ),
    );

    await expect(getMailThread("thread-1", fetchImpl)).resolves.toMatchObject({ id: "thread-1" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/mail.thread.get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "thread-1" }),
    });
  });

  it("marks spam and lists filters via the registered tools (no 404)", async () => {
    const fetchImpl = vi.fn((url: RequestInfo | URL) => {
      if (String(url).includes("mail.spam")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            threadId: "thread-1",
            spamAt: "2026-05-20T12:00:00.000Z",
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          filters: [
            {
              id: "f1",
              name: "News",
              enabled: true,
              priority: 100,
              criteria: {},
              actions: {},
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      );
    });

    await spamMailThread("thread-1", fetchImpl);
    const filters = await listMailFilters(fetchImpl);
    expect(filters).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/mail.spam", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "thread-1", spam: true }),
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/mail.filter.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  });

  it("archives, deletes, and applies labels through write tools", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({ ok: true })));

    await archiveMailThread("thread-1", fetchImpl);
    await deleteMailThread("thread-1", fetchImpl);
    await applyMailLabels({ threadId: "thread-1", add: ["team"], remove: ["planning"] }, fetchImpl);
    await snoozeMailThread({ threadId: "thread-1", until: "2026-05-21T12:00:00.000Z" }, fetchImpl);
    await setMailThreadRead({ threadId: "thread-1", unread: true }, fetchImpl);
    await setMailThreadStarred({ threadId: "thread-1", starred: true }, fetchImpl);

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/mail.archive", expect.any(Object));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/tools/mail.delete", expect.any(Object));
    expect(fetchImpl).toHaveBeenNthCalledWith(3, "/api/tools/mail.label.apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "thread-1", add: ["team"], remove: ["planning"] }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(4, "/api/tools/mail.snooze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "thread-1", until: "2026-05-21T12:00:00.000Z" }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(5, "/api/tools/mail.read.set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "thread-1", unread: true }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(6, "/api/tools/mail.star.set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "thread-1", starred: true }),
    });
  });

  it("creates, updates, and deletes mail filters through backend tools", async () => {
    const filter = {
      id: "00000000-0000-4000-8000-000000000501",
      name: "Launch planning",
      enabled: true,
      priority: 80,
      criteria: { subjectContains: "launch", hasAttachment: true },
      actions: { applyLabels: ["planning"], archive: true },
      createdAt: "2026-05-20T10:00:00.000Z",
      updatedAt: "2026-05-20T10:00:00.000Z",
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(filter))
      .mockResolvedValueOnce(Response.json({ ...filter, enabled: false }))
      .mockResolvedValueOnce(Response.json({ deleted: true }));

    await expect(
      createMailFilter(
        {
          name: "Launch planning",
          priority: 80,
          criteria: { subjectContains: "launch", hasAttachment: true },
          actions: { applyLabels: ["planning"], archive: true },
        },
        fetchImpl,
      ),
    ).resolves.toEqual(filter);
    await expect(
      updateMailFilter({ id: filter.id, enabled: false }, fetchImpl),
    ).resolves.toMatchObject({ enabled: false });
    await expect(deleteMailFilter(filter.id, fetchImpl)).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/mail.filter.create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Launch planning",
        enabled: true,
        priority: 80,
        criteria: { subjectContains: "launch", hasAttachment: true },
        actions: { applyLabels: ["planning"], archive: true },
      }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/tools/mail.filter.update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: filter.id, enabled: false }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(3, "/api/tools/mail.filter.delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: filter.id }),
    });
  });

  it("gets and sets vacation settings through backend tools", async () => {
    const vacation = {
      id: "00000000-0000-4000-8000-000000000601",
      enabled: true,
      subject: "Out of office",
      body: "I am away this week.",
      startsAt: "2026-05-20T09:00:00.000Z",
      endsAt: "2026-05-27T17:00:00.000Z",
      updatedAt: "2026-05-20T10:00:00.000Z",
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ vacation }))
      .mockResolvedValueOnce(Response.json({ vacation: { ...vacation, enabled: false } }));

    await expect(getMailVacation(fetchImpl)).resolves.toEqual(vacation);
    await expect(
      setMailVacation(
        {
          enabled: false,
          subject: vacation.subject,
          body: vacation.body,
          startsAt: vacation.startsAt,
          endsAt: vacation.endsAt,
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({ enabled: false });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/mail.vacation.get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/tools/mail.vacation.set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: false,
        subject: "Out of office",
        body: "I am away this week.",
        startsAt: "2026-05-20T09:00:00.000Z",
        endsAt: "2026-05-27T17:00:00.000Z",
      }),
    });
  });

  it("surfaces backend tool errors", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ error: "missing mail scope" }, { status: 403 })),
    );

    await expect(searchMail({}, fetchImpl)).rejects.toThrow("missing mail scope");
  });
});
