// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, byRole, click, mount, settle, unmountAll } from "@/test/ui";
import { driveItemFromEntry } from "./drive-data";
import { driveItemActions } from "./drive-item-actions";
import { NO_DRIVE_FILTERS } from "./drive-sort-filter";
import { entry, OTHER } from "./drive-test-server";
import { DriveFilterBar, DriveSelectionBar } from "./drive-toolbar";

afterEach(unmountAll);

const file = driveItemFromEntry(entry({ id: "a", type: "file", name: "a.pdf" }));
const other = driveItemFromEntry(
  entry({
    id: "b",
    type: "file",
    name: "b.pdf",
    ownerActorId: OTHER,
    ownerDisplayName: "Sam Patel",
  }),
);

function button(name: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) =>
      candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name,
  );
  if (match === undefined) throw new Error(`No button ${name}`);
  return match;
}

async function openMenu(trigger: HTMLElement) {
  trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  await settle();
}

describe("DriveSelectionBar", () => {
  it("shows the count, the primary actions and a clear button", async () => {
    const onAction = vi.fn();
    const onClear = vi.fn();
    mount(
      <DriveSelectionBar
        count={2}
        actions={driveItemActions([file, other], { trash: false })}
        onAction={onAction}
        onClear={onClear}
      />,
    );
    expect(document.body.textContent).toContain("2 selected");
    for (const label of ["Download", "Move", "Add to starred", "Move to trash", "More actions"]) {
      expect(button(label)).toBeTruthy();
    }
    click(button("Move to trash"));
    expect(onAction).toHaveBeenCalledWith("trash");
    click(button("Clear selection"));
    expect(onClear).toHaveBeenCalled();
    expect(await axeViolations()).toEqual([]);
  });

  it("offers restore and delete forever in Trash", () => {
    mount(
      <DriveSelectionBar
        count={1}
        actions={driveItemActions([file], { trash: true })}
        onAction={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(button("Restore")).toBeTruthy();
    expect(button("Delete forever").disabled).toBe(true);
  });
});

describe("DriveFilterBar", () => {
  it("applies Type, People and sort choices and toggles the layout", async () => {
    const onFiltersChange = vi.fn();
    const onSortChange = vi.fn();
    const onViewChange = vi.fn();
    mount(
      <DriveFilterBar
        items={[file, other]}
        actorId="me"
        filters={NO_DRIVE_FILTERS}
        onFiltersChange={onFiltersChange}
        sort={{ key: "name", direction: "asc" }}
        onSortChange={onSortChange}
        sortable
        view="grid"
        onViewChange={onViewChange}
        detailsOpen={false}
        onToggleDetails={vi.fn()}
      />,
    );
    await openMenu(button("Type"));
    click(byRole("menuitem", "PDFs")[0] ?? null);
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...NO_DRIVE_FILTERS, type: "pdf" });

    await openMenu(button("People"));
    click(byRole("menuitem", "Sam Patel")[0] ?? null);
    expect(onFiltersChange).toHaveBeenLastCalledWith({
      ...NO_DRIVE_FILTERS,
      people: { kind: "owner", actorId: OTHER, label: "Sam Patel" },
    });

    await openMenu(button("Sort by Name, ascending"));
    click(byRole("menuitemradio", "Last modified")[0] ?? null);
    expect(onSortChange).toHaveBeenLastCalledWith({ key: "modified", direction: "desc" });

    click(button("List layout"));
    expect(onViewChange).toHaveBeenCalledWith("list");
    expect(button("Grid layout").getAttribute("aria-pressed")).toBe("true");
  });

  it("shows an active chip with a clear button", () => {
    const onFiltersChange = vi.fn();
    mount(
      <DriveFilterBar
        items={[file]}
        actorId="me"
        filters={{ ...NO_DRIVE_FILTERS, type: "pdf" }}
        onFiltersChange={onFiltersChange}
        sort={{ key: "name", direction: "asc" }}
        onSortChange={vi.fn()}
        sortable={false}
        view="list"
        onViewChange={vi.fn()}
        detailsOpen
        onToggleDetails={vi.fn()}
      />,
    );
    expect(button("Type: PDFs")).toBeTruthy();
    click(button("Clear type filter"));
    expect(onFiltersChange).toHaveBeenCalledWith(NO_DRIVE_FILTERS);
    expect(document.querySelector('[aria-label^="Sort by"]')).toBeNull();
    expect(button("View details").getAttribute("aria-pressed")).toBe("true");
  });
});
