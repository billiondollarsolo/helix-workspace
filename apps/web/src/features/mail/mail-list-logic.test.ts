import { describe, expect, it } from "vitest";
import type { MailLabelSummary, MailThreadMessage, MailThreadRow } from "./api";
import { actionMessage, inverseMailAction, leavesView, patchRow, runBatched } from "./mail-actions";
import { labelTree } from "./mail-label-tree";
import { subsetIds } from "./mail-list-toolbar";
import { recipientsLine } from "./mail-message";
import { buildMailQuery, EMPTY_SEARCH_OPTIONS, parseMailQuery } from "./mail-search";
import { snoozePresets } from "./mail-snooze";
import { folderCount } from "./mail-taxonomy";
import { foldMessages } from "./mail-thread-view";
import { formatBytes, participantsLabel, restoreActionLabel } from "./mail-view-helpers";
import { mailSearchParams } from "./use-mail-url-state";

function row(overrides: Partial<MailThreadRow> = {}): MailThreadRow {
  return {
    threadId: "t1",
    messageId: "m1",
    subject: "Plans",
    from: "Samara Malik",
    fromEmail: "samara@example.com",
    preview: "",
    time: "2026-10-09T10:00:00.000Z",
    unread: false,
    starred: false,
    hasAttachment: false,
    messageCount: 1,
    labels: [],
    category: "primary",
    folder: "inbox",
    snoozedUntil: null,
    participants: [],
    ...overrides,
  };
}

function label(id: string, parentId: string | null, sortOrder = 0): MailLabelSummary {
  return {
    id,
    slug: id,
    name: id.toUpperCase(),
    color: "",
    colorName: "teal",
    parentId,
    sortOrder,
    threadCount: 0,
    unreadCount: 0,
    shared: false,
  };
}

describe("search options", () => {
  it("builds operator queries from the form", () => {
    expect(
      buildMailQuery({
        ...EMPTY_SEARCH_OPTIONS,
        from: "Samara Malik",
        to: "me",
        subject: "launch",
        words: "budget",
        hasAttachment: true,
        scope: "anywhere",
      }),
    ).toBe('from:"Samara Malik" to:me subject:launch has:attachment in:anywhere budget');
    expect(buildMailQuery({ ...EMPTY_SEARCH_OPTIONS, withinDays: 7 })).toBe("newer_than:7d");
    expect(buildMailQuery({ ...EMPTY_SEARCH_OPTIONS, withinDays: 1, withinOf: "2026-03-10" })).toBe(
      "after:2026/03/09 before:2026/03/12",
    );
  });

  it("reads a typed query back into the form", () => {
    expect(
      parseMailQuery('from:"Samara Malik" has:attachment in:sent report label:finance'),
    ).toEqual({
      ...EMPTY_SEARCH_OPTIONS,
      from: "Samara Malik",
      hasAttachment: true,
      scope: "sent",
      label: "finance",
      words: "report",
    });
    expect(parseMailQuery("has:drive in:nowhere").words).toBe("has:drive in:nowhere");
  });
});

describe("snooze presets", () => {
  it("offers later today, tomorrow, the weekend and next week on a weekday morning", () => {
    const presets = snoozePresets(new Date(2026, 9, 7, 9, 0));
    expect(presets.map((preset) => preset.id)).toEqual([
      "later-today",
      "tomorrow",
      "weekend",
      "next-week",
    ]);
    expect(presets[0]?.until).toEqual(new Date(2026, 9, 7, 18, 0));
    expect(presets[1]?.until).toEqual(new Date(2026, 9, 8, 8, 0));
    expect(presets[2]?.until).toEqual(new Date(2026, 9, 10, 8, 0));
    expect(presets[3]?.until).toEqual(new Date(2026, 9, 12, 8, 0));
  });

  it("follows working hours and drops choices that no longer make sense", () => {
    const presets = snoozePresets(new Date(2026, 9, 7, 17, 30), {
      enabled: true,
      days: [
        { day: 3, start: "09:30", end: "17:00" },
        { day: 4, start: "10:00", end: "18:00" },
        { day: 1, start: "07:45", end: "16:00" },
      ],
    });
    expect(presets.map((preset) => preset.id)).toEqual(["tomorrow", "weekend", "next-week"]);
    expect(presets[0]?.until).toEqual(new Date(2026, 9, 8, 10, 0));
    // Saturday is not a working day: the earliest working start is used.
    expect(presets[1]?.until).toEqual(new Date(2026, 9, 10, 7, 45));
    expect(presets[2]?.until).toEqual(new Date(2026, 9, 12, 7, 45));
  });

  it("does not repeat Monday as both tomorrow and next week on a Sunday", () => {
    const presets = snoozePresets(new Date(2026, 9, 11, 20, 0));
    expect(presets.map((preset) => preset.id)).toEqual(["tomorrow"]);
  });
});

describe("mail actions", () => {
  it("undoes each action with its opposite, using the state before it", () => {
    expect(inverseMailAction({ kind: "archive" }, undefined)).toEqual({ kind: "unarchive" });
    expect(inverseMailAction({ kind: "trash" }, undefined)).toEqual({ kind: "restore" });
    expect(inverseMailAction({ kind: "spam" }, undefined)).toEqual({ kind: "notSpam" });
    expect(inverseMailAction({ kind: "read", unread: false }, row({ unread: true }))).toEqual({
      kind: "read",
      unread: true,
    });
    expect(
      inverseMailAction(
        { kind: "label", add: ["a", "b"], remove: ["c"] },
        row({ labels: ["a", "c"] }),
      ),
    ).toEqual({ kind: "label", add: ["c"], remove: ["b"] });
    expect(inverseMailAction({ kind: "snooze", until: "2026-10-12T08:00:00Z" }, row())).toEqual({
      kind: "unsnooze",
    });
    expect(inverseMailAction({ kind: "moveToLabel", label: "x" }, undefined)).toEqual({
      kind: "moveFromLabel",
      label: "x",
    });
  });

  it("knows which actions take a row out of the view on screen", () => {
    const inbox = { folder: "inbox", label: null, query: "" } as const;
    expect(leavesView({ kind: "archive" }, inbox)).toBe(true);
    expect(leavesView({ kind: "read", unread: true }, inbox)).toBe(false);
    expect(leavesView({ kind: "archive" }, { ...inbox, folder: "all" })).toBe(false);
    expect(leavesView({ kind: "restore" }, { ...inbox, folder: "trash" })).toBe(true);
    expect(leavesView({ kind: "star", starred: false }, { ...inbox, folder: "starred" })).toBe(
      true,
    );
    expect(
      leavesView({ kind: "label", add: [], remove: ["team"] }, { ...inbox, label: "team" }),
    ).toBe(true);
    expect(leavesView({ kind: "archive" }, { ...inbox, query: "from:x" })).toBe(false);
    expect(leavesView({ kind: "trash" }, { ...inbox, query: "from:x" })).toBe(true);
  });

  it("patches rows optimistically and words the snackbar", () => {
    expect(
      patchRow(row({ labels: ["a"] }), { kind: "label", add: ["b"], remove: ["a"] }).labels,
    ).toEqual(["b"]);
    expect(patchRow(row(), { kind: "star", starred: true }).starred).toBe(true);
    expect(actionMessage({ kind: "archive" }, 1)).toBe("Conversation archived");
    expect(actionMessage({ kind: "trash" }, 3)).toBe("3 conversations moved to Trash");
    expect(
      actionMessage({ kind: "label", add: ["team"], remove: [] }, 2, (slug) => slug.toUpperCase()),
    ).toBe('2 conversations labelled "TEAM"');
  });

  it("runs batches and reports the ids that failed", async () => {
    const failed = await runBatched(["a", "b", "c"], (id) =>
      id === "b" ? Promise.reject(new Error("no")) : Promise.resolve(),
    );
    expect(failed).toEqual(["b"]);
  });
});

describe("list presentation", () => {
  it("names conversations by their participants", () => {
    expect(
      participantsLabel(row({ participants: [{ name: "Samara Malik", email: "s", isMe: false }] })),
    ).toBe("Samara Malik");
    expect(
      participantsLabel(
        row({
          messageCount: 3,
          participants: [
            { name: "Samara Malik", email: "s", isMe: false },
            { name: "me", email: "m", isMe: true },
          ],
        }),
      ),
    ).toBe("Samara, me (3)");
    expect(
      participantsLabel(
        row({
          messageCount: 6,
          participants: [
            { name: "Samara Malik", email: "s", isMe: false },
            { name: "Ravi Iyer", email: "r", isMe: false },
            { name: "Jun Park", email: "j", isMe: false },
            { name: "me", email: "m", isMe: true },
          ],
        }),
      ),
    ).toBe("Samara .. Jun, me (6)");
    expect(participantsLabel(row({ participants: [] }))).toBe("Samara Malik");
  });

  it("counts unread for Inbox, the total for Drafts, nothing elsewhere", () => {
    expect(folderCount({ id: "inbox", total: 9, unread: 3 })).toBe(3);
    expect(folderCount({ id: "drafts", total: 2, unread: 0 })).toBe(2);
    expect(folderCount({ id: "sent", total: 120, unread: 0 })).toBe(0);
    expect(folderCount({ id: "starred", total: 4, unread: 1 })).toBe(0);
  });

  it("selects subsets for the select-all menu", () => {
    const rows = [
      row({ threadId: "a", unread: true }),
      row({ threadId: "b", starred: true }),
      row({ threadId: "c" }),
    ];
    expect([...subsetIds(rows, "unread")]).toEqual(["a"]);
    expect([...subsetIds(rows, "read")]).toEqual(["b", "c"]);
    expect([...subsetIds(rows, "starred")]).toEqual(["b"]);
    expect([...subsetIds(rows, "unstarred")]).toEqual(["a", "c"]);
    expect(subsetIds(rows, "none").size).toBe(0);
  });

  it("orders nested labels under their parents", () => {
    const tree = labelTree([
      label("b", null, 2),
      label("a", null, 1),
      label("a1", "a"),
      label("x", "gone"),
    ]);
    expect(tree.map((entry) => [entry.label.id, entry.depth])).toEqual([
      ["x", 0],
      ["a", 0],
      ["a1", 1],
      ["b", 0],
    ]);
  });

  it("offers a way back out of Trash, Archive and Snoozed", () => {
    expect(restoreActionLabel("trash")).toBe("Move to Inbox");
    expect(restoreActionLabel("snoozed")).toBe("Unsnooze");
    expect(restoreActionLabel("inbox")).toBeNull();
    expect(formatBytes(248_000)).toBe("242 KB");
    expect(formatBytes(900)).toBe("900 B");
  });

  it("keeps the view in the URL without defaults", () => {
    expect(
      mailSearchParams({ folder: "inbox", tab: "primary", label: null, query: "", thread: null }),
    ).toEqual({
      folder: undefined,
      tab: undefined,
      label: undefined,
      q: undefined,
      thread: undefined,
    });
    expect(
      mailSearchParams({ folder: "sent", tab: "social", label: "team", query: "x", thread: "t" }),
    ).toEqual({ folder: undefined, tab: undefined, label: "team", q: "x", thread: "t" });
  });
});

describe("conversation", () => {
  const message = (id: string): MailThreadMessage => ({
    id,
    from: { address: "s@example.com", name: "Samara Malik" },
    to: [
      { address: "me@example.com", name: "Me" },
      { address: "ravi@example.com", name: "Ravi Iyer" },
    ],
    cc: [{ address: "jun@example.com" }],
    bcc: [],
    sentAt: "2026-10-09T10:00:00.000Z",
    body: "Hi",
    bodyFormat: "plain",
    hasAttachment: false,
    attachments: [],
  });

  it("folds the middle of long conversations", () => {
    const messages = ["1", "2", "3", "4", "5", "6"].map(message);
    const folded = foldMessages(messages, false);
    expect(
      folded.map((entry) => (entry.kind === "fold" ? `+${String(entry.count)}` : entry.message.id)),
    ).toEqual(["1", "+3", "5", "6"]);
    expect(foldMessages(messages, true)).toHaveLength(6);
    expect(foldMessages(messages.slice(0, 4), false)).toHaveLength(4);
  });

  it("writes recipients as 'to me, Ravi'", () => {
    expect(recipientsLine(message("1"), "ME@example.com")).toBe("to me, Ravi, jun@example.com");
  });
});
