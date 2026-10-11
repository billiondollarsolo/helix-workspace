// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, byRole, key, mount, settle, unmountAll } from "@/test/ui";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  isContextMenuKey,
} from "./context-menu";

function Example({ onArchive = vi.fn() }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div tabIndex={0} aria-label="Quarterly report">
          Quarterly report
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label="File actions">
        <ContextMenuLabel>File</ContextMenuLabel>
        <ContextMenuGroup>
          <ContextMenuItem shortcut="e" onSelect={onArchive}>
            Archive
          </ContextMenuItem>
          <ContextMenuItem destructive>Move to trash</ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem checked>Starred</ContextMenuCheckboxItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Move to</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem>Projects</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function target(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[aria-label="Quarterly report"]');
  if (!node) throw new Error("missing trigger");
  return node;
}

describe("ContextMenu", () => {
  afterEach(unmountAll);

  it("recognises Shift+F10 and the Menu key", () => {
    expect(isContextMenuKey({ key: "F10", shiftKey: true })).toBe(true);
    expect(isContextMenuKey({ key: "ContextMenu", shiftKey: false })).toBe(true);
    expect(isContextMenuKey({ key: "F10", shiftKey: false })).toBe(false);
  });

  it("opens on right-click with menu semantics and passes axe", async () => {
    mount(<Example />);
    act(() => {
      target().dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    await settle();
    expect(byRole("menu")).toHaveLength(1);
    expect(byRole("menuitem").map((item) => item.textContent)).toEqual([
      "Archivee",
      "Move to trash",
      "Move to",
    ]);
    expect(await axeViolations()).toEqual([]);
  });

  it("opens with Shift+F10 on the focused target and selects with the keyboard", async () => {
    const onArchive = vi.fn();
    mount(<Example onArchive={onArchive} />);
    target().focus();
    await key("F10", { shiftKey: true });
    expect(byRole("menu")).toHaveLength(1);
    expect(byRole("menu")[0]?.contains(document.activeElement)).toBe(true);
    await key("End");
    expect(document.activeElement?.textContent).toContain("Move to");
    await key("Home");
    expect(document.activeElement?.textContent).toContain("Archive");
    await key("Enter");
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(byRole("menu")).toHaveLength(0);
  });

  it("opens with the Menu key and closes on Escape", async () => {
    mount(<Example />);
    target().focus();
    await key("ContextMenu");
    expect(byRole("menu")).toHaveLength(1);
    await key("Escape");
    expect(byRole("menu")).toHaveLength(0);
  });
});
