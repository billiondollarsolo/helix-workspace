// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyOptions } from "@/components/ui/toast";
import { shortcutRegistry } from "@/lib/shortcuts/registry";
import { axeViolations, click, press, unmountAll } from "@/test/ui";
import type { DriveApiEntry } from "./api";
import { DriveShell } from "./drive-shell";
import { entry, fakeDriveApi, flush, mountWithQueries } from "./drive-test-server";

const router = vi.hoisted(() => {
  const search: Record<string, unknown> = {};
  return { navigate: vi.fn(), search };
});
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => router.navigate,
  useSearch: () => router.search,
}));
const toasts = vi.hoisted(() => ({ list: [] as NotifyOptions[] }));
vi.mock("@/components/ui/toast", () => ({
  notify: (options: NotifyOptions) => {
    toasts.list.push(options);
    return toasts.list.length;
  },
}));

const FOLDER = "00000000-0000-4000-8000-0000000000f1";
const ROADMAP = "00000000-0000-4000-8000-0000000000a1";
const BUDGET = "00000000-0000-4000-8000-0000000000a2";
const SPECS = "00000000-0000-4000-8000-0000000000a3";

let entries: DriveApiEntry[];
let api: ReturnType<typeof fakeDriveApi>;

/** What AppShell's GlobalShortcuts does: route keydowns to the shortcut registry. */
function dispatchShortcuts(event: KeyboardEvent) {
  shortcutRegistry.handleKeyDown(event, {
    enabled: true,
    overlayOpen: document.querySelector('[aria-modal="true"], [role="menu"]') !== null,
    isMac: false,
  });
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="row"][data-key]'));
}
function rowName(candidate: HTMLElement): string | null {
  return candidate.querySelector(".drive-col-name [title]")?.getAttribute("title") ?? null;
}
function row(name: string): HTMLElement {
  const match = rows().find((candidate) => rowName(candidate) === name);
  if (match === undefined) throw new Error(`No row ${name}`);
  return match;
}
function button(name: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) =>
      candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name,
  );
  if (match === undefined) throw new Error(`No button ${name}`);
  return match;
}
function menuItem(name: string): HTMLElement {
  const match = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (candidate) => candidate.textContent?.startsWith(name),
  );
  if (match === undefined) throw new Error(`No menu item ${name}`);
  return match;
}
function rightClick(target: HTMLElement) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
    );
  });
}

beforeEach(() => {
  window.addEventListener("keydown", dispatchShortcuts);
  router.navigate.mockClear();
  router.search = {};
  toasts.list = [];
  entries = [
    entry({ id: FOLDER, type: "folder", name: "Engineering" }),
    entry({ id: ROADMAP, type: "file", name: "Roadmap.docx", byteSize: 2048 }),
    entry({ id: BUDGET, type: "file", name: "Budget.xlsx", byteSize: 4096 }),
    entry({ id: SPECS, type: "file", name: "Specs.pdf", byteSize: 1024 }),
  ];
  api = fakeDriveApi({
    "drive.list": (body) =>
      body.includeTrashed === true
        ? { entries: entries.filter((item) => item.deletedAt !== null), nextCursor: null }
        : { entries, nextCursor: null },
    "drive.view.get": () => ({ view: "list" }),
    "drive.view.set": (body) => ({ view: body.view }),
    "drive.storage.usage": () => ({
      usedBytes: 2_500_000,
      limitBytes: null,
      organizationUsedBytes: null,
    }),
    "drive.trash": (body) => entries.find((item) => item.id === body.objectId),
    "drive.restore": (body) => entries.find((item) => item.id === body.objectId),
    "drive.rename": (body) => ({ ...entries[1], name: body.name }),
    "drive.delete": () => ({ deleted: true }),
    "drive.access.list": () => ({ grants: [] }),
    "drive.versions.list": () => ({ versions: [] }),
  });
});

afterEach(() => {
  window.removeEventListener("keydown", dispatchShortcuts);
  unmountAll();
  vi.unstubAllGlobals();
});

async function renderShell() {
  mountWithQueries(<DriveShell />);
  await flush();
}

describe("DriveShell", () => {
  it("lists folders on top with a page heading, storage meter and no axe violations", async () => {
    await renderShell();
    expect(document.querySelector("h1")?.textContent).toContain("My Drive");
    expect(rows().map(rowName)).toEqual([
      "Engineering",
      "Budget.xlsx",
      "Roadmap.docx",
      "Specs.pdf",
    ]);
    expect(document.body.textContent).toContain("2.4 MB used");
    expect(await axeViolations()).toEqual([]);
  });

  it("selects a range with Shift-click and trashes it with Delete, then undoes", async () => {
    await renderShell();
    click(row("Budget.xlsx"));
    click(row("Specs.pdf"), { shiftKey: true });
    expect(document.body.textContent).toContain("3 selected");

    press("Delete", {}, row("Specs.pdf"));
    await flush();
    expect(
      api
        .called("drive.trash")
        .map((call) => call.body.objectId)
        .sort(),
    ).toEqual([BUDGET, ROADMAP, SPECS].sort());
    const toast = toasts.list.at(-1);
    expect(toast?.message).toBe("3 items moved to trash");
    act(() => toast?.action?.onAction());
    await flush();
    expect(api.called("drive.restore")).toHaveLength(3);
  });

  it("opens a context menu on right-click and applies it to the clicked item", async () => {
    await renderShell();
    rightClick(row("Roadmap.docx"));
    await flush(2);
    const labels = Array.from(document.querySelectorAll('[role="menuitem"]')).map(
      (item) => item.textContent,
    );
    expect(labels.join("|")).toContain("Download");
    expect(labels.join("|")).toContain("Move to trash");
    click(menuItem("Move to trash"));
    await flush();
    expect(api.called("drive.trash").map((call) => call.body.objectId)).toEqual([ROADMAP]);
    expect(toasts.list.at(-1)?.message).toBe("“Roadmap.docx” moved to trash");
  });

  it("opens the context menu with Shift+F10 on the focused row", async () => {
    await renderShell();
    const target = row("Specs.pdf");
    act(() => target.focus());
    press("F10", { shiftKey: true }, target);
    await flush(2);
    expect(menuItem("File information")).toBeTruthy();
  });

  it("renames with F2 and offers Undo", async () => {
    await renderShell();
    click(row("Roadmap.docx"));
    press("F2", {}, document.body);
    await flush(2);
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input');
    if (input === null) throw new Error("rename dialog missing");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "Roadmap 2026.docx",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click(button("OK"));
    await flush();
    expect(api.called("drive.rename")[0]?.body).toEqual({
      objectId: ROADMAP,
      name: "Roadmap 2026.docx",
    });
    act(() => toasts.list.at(-1)?.action?.onAction());
    await flush();
    expect(api.called("drive.rename")[1]?.body).toEqual({
      objectId: ROADMAP,
      name: "Roadmap.docx",
    });
  });

  it("opens folders on double-click and shows details with a", async () => {
    await renderShell();
    act(() => {
      row("Engineering").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(router.navigate).toHaveBeenCalled();
    await flush();
    expect(document.querySelector("h1")?.textContent).toContain("Engineering");

    click(row("Specs.pdf"));
    press("a", {}, document.body);
    await flush();
    const panel = document.querySelector('[data-testid="drive-details-panel"]');
    expect(panel?.textContent).toContain("Specs.pdf");
    expect(panel?.textContent).toContain("PDF");
    expect(panel?.querySelectorAll('[role="tab"]')).toHaveLength(2);
  });

  it("shows the retention banner in Trash and confirms Delete forever", async () => {
    router.search = { scope: "trash" };
    entries = [
      entry({
        id: SPECS,
        type: "file",
        name: "Specs.pdf",
        deletedAt: "2026-01-01T00:00:00.000Z",
        trashPurgeAfter: "2026-01-15T00:00:00.000Z",
      }),
    ];
    await renderShell();
    expect(document.body.textContent).toContain(
      "Items in trash are deleted forever after 14 days.",
    );
    click(row("Specs.pdf"));
    click(button("Delete forever"));
    await flush(2);
    expect(document.body.textContent).toContain("You can’t undo this.");
    click(
      Array.from(document.querySelectorAll('[role="alertdialog"] button')).find(
        (candidate) => candidate.textContent === "Delete forever",
      ) ?? null,
    );
    await flush();
    expect(api.called("drive.delete")[0]?.body).toEqual({ objectId: SPECS });
  });
});
