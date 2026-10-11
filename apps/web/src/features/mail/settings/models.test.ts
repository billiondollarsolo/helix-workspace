import { describe, expect, it } from "vitest";
import type { MailFilterRecord, MailLabelSummary } from "../api";
import { blockAddress, unblockAddress } from "./blocked-model";
import {
  describeFilterActions,
  describeFilterCriteria,
  filterCriteriaQuery,
  filterDraftFromPrefill,
  filterDraftFromRecord,
  filterPayload,
  hasFilterAction,
  hasFilterCriteria,
} from "./filter-model";
import {
  flattenLabelTree,
  labelNameError,
  labelSubtreeIds,
  parentLabelOptions,
} from "./label-model";
import {
  validateVacationDraft,
  vacationDraftFromSettings,
  vacationInputFromDraft,
  type VacationDraft,
} from "./vacation-model";

function label(id: string, name: string, parentId: string | null = null, extra = {}) {
  return {
    id,
    slug: name.toLowerCase(),
    name,
    color: "#636363",
    colorName: "gray",
    parentId,
    sortOrder: 100,
    threadCount: 0,
    unreadCount: 0,
    shared: false,
    ...extra,
  } satisfies MailLabelSummary;
}

const labels = [
  label("finance", "Finance"),
  label("acme", "Acme", "clients"),
  label("clients", "Clients"),
  label("globex", "Globex", "clients"),
  label("acme-billing", "Billing", "acme"),
  label("org", "Announcements", null, { shared: true }),
];

describe("label tree", () => {
  it("lists each label after its parent with the full path", () => {
    expect(flattenLabelTree(labels).map((entry) => [entry.path, entry.depth])).toEqual([
      ["Announcements", 0],
      ["Clients", 0],
      ["Clients/Acme", 1],
      ["Clients/Acme/Billing", 2],
      ["Clients/Globex", 1],
      ["Finance", 0],
    ]);
  });

  it("treats a label whose parent is gone as top level", () => {
    const orphan = [label("child", "Child", "missing")];
    expect(flattenLabelTree(orphan)).toMatchObject([{ path: "Child", depth: 0 }]);
  });

  it("never offers a label, its sublabels or shared labels as a parent", () => {
    expect(labelSubtreeIds(labels, "clients")).toEqual(
      new Set(["clients", "acme", "globex", "acme-billing"]),
    );
    const editingClients = parentLabelOptions(labels, "clients").map((entry) => entry.path);
    expect(editingClients).toEqual(["Finance"]);
    const creating = parentLabelOptions(labels, null).map((entry) => entry.path);
    expect(creating).not.toContain("Announcements");
    expect(creating).toContain("Clients/Acme/Billing");
  });

  it("stops offering parents at the nesting limit", () => {
    const chain = [
      label("l1", "L1"),
      label("l2", "L2", "l1"),
      label("l3", "L3", "l2"),
      label("l4", "L4", "l3"),
      label("l5", "L5", "l4"),
    ];
    expect(parentLabelOptions(chain, null).map((entry) => entry.label.id)).toEqual([
      "l1",
      "l2",
      "l3",
      "l4",
    ]);
  });

  it("validates label names", () => {
    expect(labelNameError("  ")).toBe("Enter a label name.");
    expect(labelNameError("a".repeat(226))).toBe("Use at most 225 characters.");
    expect(labelNameError("Bad\u0007name")).toMatch(/control characters/u);
    expect(labelNameError(" Clients ")).toBeNull();
  });
});

const filter: MailFilterRecord = {
  id: "filter-1",
  name: "from:billing@",
  enabled: true,
  priority: 100,
  criteria: { fromContains: "billing@", subjectContains: "invoice due", hasAttachment: true },
  actions: {
    applyLabels: ["finance", "old-label"],
    archive: true,
    markRead: true,
    snoozeUntil: "2026-11-01T09:00:00.000Z",
  },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("filter criteria → search query", () => {
  it("uses Mail search operators and quotes values with spaces", () => {
    const draft = filterDraftFromPrefill({
      from: " ada@example.net ",
      to: "team",
      subject: 'Quarterly "plan" review',
      hasWords: "budget",
      hasAttachment: true,
    });
    expect(filterCriteriaQuery(draft.criteria)).toBe(
      'from:ada@example.net to:team subject:"Quarterly plan review" budget has:attachment',
    );
  });

  it("needs at least one criterion", () => {
    const empty = filterDraftFromPrefill({});
    expect(hasFilterCriteria(empty.criteria)).toBe(false);
    expect(filterCriteriaQuery(empty.criteria)).toBe("");
    expect(hasFilterCriteria({ ...empty.criteria, hasAttachment: true })).toBe(true);
  });
});

describe("filter actions → payload", () => {
  it("sends only the chosen criteria and actions", () => {
    const draft = filterDraftFromPrefill({ from: "ada@example.net", hasWords: " " });
    const withActions = {
      ...draft,
      actions: { ...draft.actions, skipInbox: true, star: true, applyLabel: "clients" },
    };
    expect(hasFilterAction(draft)).toBe(false);
    expect(hasFilterAction(withActions)).toBe(true);
    expect(filterPayload(withActions)).toEqual({
      name: "from:ada@example.net",
      enabled: true,
      criteria: { fromContains: "ada@example.net" },
      actions: { archive: true, star: true, applyLabels: ["clients"] },
    });
  });

  it("round-trips a saved filter and keeps actions the dialog does not edit", () => {
    const draft = filterDraftFromRecord(filter);
    expect(draft.criteria).toEqual({
      from: "billing@",
      to: "",
      subject: "invoice due",
      hasWords: "",
      hasAttachment: true,
    });
    expect(draft.actions).toMatchObject({ skipInbox: true, markRead: true, applyLabel: "finance" });
    const changed = { ...draft, actions: { ...draft.actions, markRead: false, delete: true } };
    expect(filterPayload(changed).actions).toEqual({
      archive: true,
      applyLabels: ["finance", "old-label"],
      delete: true,
      snoozeUntil: "2026-11-01T09:00:00.000Z",
    });
  });

  it("describes criteria and actions for the filter list", () => {
    expect(describeFilterCriteria(filter)).toBe(
      'from:billing@ subject:"invoice due" has:attachment',
    );
    expect(describeFilterActions(filter, [label("f", "Finance")], () => "Nov 1")).toBe(
      "Skip Inbox, Mark as read, Apply label “Finance”, Apply label “old-label (removed)”, Snooze until Nov 1",
    );
  });
});

describe("vacation responder form", () => {
  const today = new Date(2026, 9, 11, 15, 30);
  const on: VacationDraft = {
    enabled: true,
    firstDay: "2026-10-20",
    hasLastDay: true,
    lastDay: "2026-10-24",
    subject: "Out of office",
    message: "Back on Monday.",
  };

  it("starts off, from today, when nothing is saved", () => {
    expect(vacationDraftFromSettings(null, today)).toEqual({
      enabled: false,
      firstDay: "2026-10-11",
      hasLastDay: false,
      lastDay: "",
      subject: "",
      message: "",
    });
  });

  it("requires a first day, subject and message only while on", () => {
    expect(validateVacationDraft({ ...on, enabled: false, subject: "", message: "" })).toEqual({});
    expect(validateVacationDraft({ ...on, firstDay: "", subject: " ", message: "" })).toEqual({
      firstDay: "Choose the first day.",
      subject: "Add a subject.",
      message: "Write the reply people will get.",
    });
  });

  it("rejects a last day before the first day", () => {
    expect(validateVacationDraft({ ...on, lastDay: "2026-10-19" })).toEqual({
      lastDay: "The last day can't be before the first day.",
    });
    expect(validateVacationDraft({ ...on, lastDay: "" })).toEqual({
      lastDay: "Choose the last day, or clear Last day.",
    });
    expect(validateVacationDraft({ ...on, hasLastDay: false, lastDay: "" })).toEqual({});
  });

  it("covers whole local days and reads back the same days", () => {
    const input = vacationInputFromDraft(on);
    expect(input).toEqual({
      enabled: true,
      subject: "Out of office",
      body: "Back on Monday.",
      startsAt: new Date(2026, 9, 20).toISOString(),
      endsAt: new Date(new Date(2026, 9, 25).getTime() - 1).toISOString(),
    });
    expect(
      vacationDraftFromSettings(
        {
          enabled: true,
          subject: input.subject,
          body: input.body,
          startsAt: input.startsAt ?? null,
          endsAt: input.endsAt ?? null,
        },
        today,
      ),
    ).toEqual(on);
    expect(vacationInputFromDraft({ ...on, hasLastDay: false }).endsAt).toBeNull();
  });
});

describe("blocked addresses", () => {
  it("adds a normalized address once", () => {
    expect(blockAddress(["b@example.com"], "  A@Example.com ")).toEqual({
      kind: "ok",
      address: "a@example.com",
      list: ["a@example.com", "b@example.com"],
    });
    expect(blockAddress(["a@example.com"], "a@example.com")).toEqual({
      kind: "error",
      message: "a@example.com is already blocked.",
    });
  });

  it("explains invalid input and the limit", () => {
    expect(blockAddress([], "")).toMatchObject({ message: "Enter an email address to block." });
    expect(blockAddress([], "not-an-address")).toMatchObject({
      message: "Enter a full email address, like name@example.com.",
    });
    const full = Array.from({ length: 1000 }, (_, index) => `u${String(index)}@example.com`);
    expect(blockAddress(full, "new@example.com")).toMatchObject({ kind: "error" });
  });

  it("unblocks", () => {
    expect(unblockAddress(["a@example.com", "b@example.com"], "a@example.com")).toEqual([
      "b@example.com",
    ]);
  });
});
