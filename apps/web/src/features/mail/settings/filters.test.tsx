// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axeViolations, click, settle, unmountAll } from "@/test/ui";
import type { MailFilterRecord, MailLabelSummary, MailUserSettings } from "../api";
import { FiltersTab } from "./filters-tab";
import { MailDialogsHost, openFilterDialog, type MailFilterPrefill } from "./index";
import {
  buttonNamed,
  choose,
  control,
  dialogNamed,
  renderSettings,
  typeInto,
  waitFor,
} from "./test-support";

const api = vi.hoisted(() => ({
  listMailFilters: vi.fn(),
  createMailFilter: vi.fn(),
  updateMailFilter: vi.fn(),
  deleteMailFilter: vi.fn(),
  listMailLabels: vi.fn(),
  listMailThreads: vi.fn(),
  getMailUserSettings: vi.fn(),
  setMailUserSettings: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  ...api,
}));

const finance: MailLabelSummary = {
  id: "finance-id",
  slug: "finance",
  name: "Finance",
  color: "#935200",
  colorName: "amber",
  parentId: null,
  sortOrder: 100,
  threadCount: 0,
  unreadCount: 0,
  shared: false,
};

const saved: MailFilterRecord = {
  id: "filter-1",
  name: "from:billing@",
  enabled: true,
  priority: 100,
  criteria: { fromContains: "billing@" },
  actions: { applyLabels: ["finance"], markRead: true },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const settings: MailUserSettings = {
  signatureText: "",
  signatureHtml: null,
  includeSignatureOnReplies: true,
  blockedSenders: ["spam@example.net"],
  updatedAt: null,
};

beforeEach(() => {
  api.listMailFilters.mockResolvedValue([saved]);
  api.createMailFilter.mockImplementation((input: object) =>
    Promise.resolve({ ...saved, ...input, id: "filter-2" }),
  );
  api.updateMailFilter.mockResolvedValue(saved);
  api.deleteMailFilter.mockResolvedValue(true);
  api.listMailLabels.mockResolvedValue([finance]);
  api.listMailThreads.mockResolvedValue({ threads: [], total: 2, limit: 1, offset: 0 });
  api.getMailUserSettings.mockResolvedValue(settings);
  api.setMailUserSettings.mockImplementation((input: Partial<MailUserSettings>) =>
    Promise.resolve({ ...settings, ...input }),
  );
});

afterEach(() => {
  unmountAll();
  vi.clearAllMocks();
});

function renderFilters() {
  return renderSettings(
    <>
      <FiltersTab />
      <MailDialogsHost />
    </>,
  );
}

function filterDialog(): Promise<HTMLElement> {
  return waitFor(
    () => dialogNamed("Create a filter") ?? dialogNamed("Edit filter"),
    "filter dialog",
  );
}

function errorIn(dialog: HTMLElement): string | undefined {
  return dialog.querySelector('[role="alert"]')?.textContent ?? undefined;
}

describe("Filters", () => {
  it("lists each filter as criteria and actions", async () => {
    renderFilters();
    const list = await waitFor(() => document.querySelector('ul[aria-label="Filters"]'), "list");
    await waitFor(() => (list.textContent?.includes("Finance") === true ? true : null), "labels");
    expect(list.textContent).toContain("Matchesfrom:billing@");
    expect(list.textContent).toContain("Do thisMark as read, Apply label “Finance”");
    expect(await axeViolations()).toEqual([]);
  });

  it("shows an empty state with a way to create one", async () => {
    api.listMailFilters.mockResolvedValue([]);
    renderFilters();
    await waitFor(
      () => (document.body.textContent?.includes("No filters yet") ? true : null),
      "empty",
    );
    expect(buttonNamed("Add filter")).not.toBeNull();
  });

  it("creates a filter in two steps: criteria, preview, then actions", async () => {
    renderFilters();
    click(await waitFor(() => buttonNamed("Add filter"), "create button"));
    let dialog = await filterDialog();
    expect(await axeViolations()).toEqual([]);

    click(buttonNamed("Continue", dialog));
    await settle();
    expect(errorIn(dialog)).toMatch(/Fill in at least one field/u);

    typeInto(control("From", dialog), "ada@example.net");
    typeInto(control("Subject", dialog), "monthly report");
    click(control("Has attachment", dialog));
    click(buttonNamed("Search", dialog));
    await waitFor(
      () => (dialog.textContent?.includes("2 conversations match.") ? true : null),
      "match count",
    );
    expect(api.listMailThreads).toHaveBeenCalledWith({
      folder: "all",
      query: 'from:ada@example.net subject:"monthly report" has:attachment',
      limit: 1,
    });

    click(buttonNamed("Continue", dialog));
    dialog = await filterDialog();
    expect(dialog.textContent).toContain("Step 2 of 2");
    click(buttonNamed("Create filter", dialog));
    await settle();
    expect(errorIn(dialog)).toMatch(/Choose at least one thing/u);

    click(control("Skip the Inbox (Archive it)", dialog));
    click(control("Mark as read", dialog));
    click(control("Star it", dialog));
    await waitFor(
      () => control<HTMLSelectElement>("Label to apply", dialog)?.options.length,
      "labels",
    );
    click(control("Apply the label:", dialog));
    choose(control<HTMLSelectElement>("Label to apply", dialog), "finance");
    expect(await axeViolations()).toEqual([]);
    click(buttonNamed("Create filter", dialog));
    await waitFor(() => (dialogNamed("Create a filter") === null ? true : null), "close");

    expect(api.createMailFilter).toHaveBeenCalledWith({
      name: 'from:ada@example.net subject:"monthly report" has:attachment',
      enabled: true,
      criteria: {
        fromContains: "ada@example.net",
        subjectContains: "monthly report",
        hasAttachment: true,
      },
      actions: { archive: true, markRead: true, star: true, applyLabels: ["finance"] },
    });
  });

  it("opens prefilled from another surface", async () => {
    renderFilters();
    const prefill: MailFilterPrefill = { from: "news@example.org", hasWords: "unsubscribe" };
    openFilterDialog(prefill);
    const dialog = await filterDialog();
    expect(control("From", dialog)?.value).toBe("news@example.org");
    expect(control("Has the words", dialog)?.value).toBe("unsubscribe");
    expect(control("To", dialog)?.value).toBe("");
  });

  it("edits a saved filter in place", async () => {
    renderFilters();
    click(await waitFor(() => buttonNamed("Edit filter from:billing@"), "edit button"));
    let dialog = await filterDialog();
    expect(control("From", dialog)?.value).toBe("billing@");
    click(buttonNamed("Continue", dialog));
    dialog = await filterDialog();
    await waitFor(
      () => control<HTMLSelectElement>("Label to apply", dialog)?.options.length,
      "labels",
    );
    expect(control("Mark as read", dialog)?.checked).toBe(true);
    expect(control("Apply the label:", dialog)?.checked).toBe(true);
    click(control("Delete it", dialog));
    click(buttonNamed("Update filter", dialog));
    await waitFor(() => (dialogNamed("Edit filter") === null ? true : null), "close");

    expect(api.updateMailFilter).toHaveBeenCalledWith({
      id: "filter-1",
      name: "from:billing@",
      enabled: true,
      criteria: { fromContains: "billing@" },
      actions: { markRead: true, applyLabels: ["finance"], delete: true },
    });
  });

  it("deletes a filter after confirming", async () => {
    renderFilters();
    click(await waitFor(() => buttonNamed("Delete filter from:billing@"), "delete button"));
    const dialog = await waitFor(() => dialogNamed("Delete this filter?"), "confirm");
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    click(buttonNamed("Delete", dialog));
    await waitFor(() => (dialogNamed("Delete this filter?") === null ? true : null), "close");
    expect(api.deleteMailFilter).toHaveBeenCalledWith("filter-1");
  });
});

describe("Blocked addresses", () => {
  it("blocks a new address and unblocks one", async () => {
    renderFilters();
    const list = await waitFor(
      () => document.querySelector('ul[aria-label="Blocked addresses"]'),
      "blocked list",
    );
    expect(list.textContent).toContain("spam@example.net");

    const input = control("Address to block");
    typeInto(input, "not an address");
    click(buttonNamed("Block"));
    await settle();
    expect(input?.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(input?.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("Enter a full email address, like name@example.com.");
    expect(api.setMailUserSettings).not.toHaveBeenCalled();

    typeInto(input, " Pest@Example.com ");
    click(buttonNamed("Block"));
    await waitFor(() => (input?.value === "" ? true : null), "input to clear");
    expect(api.setMailUserSettings).toHaveBeenLastCalledWith({
      blockedSenders: ["pest@example.com", "spam@example.net"],
    });

    click(buttonNamed("Unblock spam@example.net"));
    await settle();
    expect(api.setMailUserSettings).toHaveBeenLastCalledWith({
      blockedSenders: ["pest@example.com"],
    });
  });

  it("says when nothing is blocked", async () => {
    api.getMailUserSettings.mockResolvedValue({ ...settings, blockedSenders: [] });
    renderFilters();
    await waitFor(
      () => (document.body.textContent?.includes("No blocked addresses") ? true : null),
      "empty state",
    );
  });
});
