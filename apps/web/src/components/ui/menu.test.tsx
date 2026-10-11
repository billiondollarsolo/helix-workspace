// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, byRole, key, mount, press, settle, unmountAll } from "@/test/ui";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from "./menu";

function Example({ onArchive = vi.fn(), onRed = vi.fn() }) {
  return (
    <Menu>
      <MenuTrigger>Actions</MenuTrigger>
      <MenuContent aria-label="Actions">
        <MenuLabel>Conversation</MenuLabel>
        <MenuGroup>
          <MenuItem shortcut="e" onSelect={onArchive}>
            Archive
          </MenuItem>
          <MenuItem destructive>Delete</MenuItem>
          <MenuItem disabled>Mute</MenuItem>
          <MenuItem>Mark as unread</MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuCheckboxItem checked>Show snippets</MenuCheckboxItem>
        <MenuRadioGroup value="newest">
          <MenuRadioItem value="newest">Newest first</MenuRadioItem>
        </MenuRadioGroup>
        <MenuSub>
          <MenuSubTrigger>Label as</MenuSubTrigger>
          <MenuSubContent>
            <MenuItem onSelect={onRed}>Red</MenuItem>
            <MenuItem>Blue</MenuItem>
          </MenuSubContent>
        </MenuSub>
      </MenuContent>
    </Menu>
  );
}

async function openMenu() {
  const trigger = byRole("button", "Actions")[0] ?? document.querySelector("button");
  trigger?.focus();
  press("Enter", {}, trigger ?? null);
  await settle();
  return trigger;
}

describe("Menu", () => {
  afterEach(unmountAll);

  it("opens from the keyboard with menu roles and focus on the first item", async () => {
    mount(<Example />);
    const trigger = await openMenu();
    expect(trigger?.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(byRole("menu")).toHaveLength(1);
    expect(byRole("menuitemcheckbox")).toHaveLength(1);
    expect(byRole("menuitemradio")).toHaveLength(1);
    expect(document.activeElement?.textContent).toContain("Archive");
    expect(await axeViolations()).toEqual([]);
  });

  it("moves with arrows, skips disabled items, and wraps nothing past the end", async () => {
    mount(<Example />);
    await openMenu();
    await key("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Delete");
    await key("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Mark as unread");
    await key("Home");
    expect(document.activeElement?.textContent).toContain("Archive");
    await key("End");
    expect(document.activeElement?.textContent).toContain("Label as");
  });

  it("jumps by typeahead", async () => {
    mount(<Example />);
    await openMenu();
    await key("m");
    expect(document.activeElement?.textContent).toBe("Mark as unread");
  });

  it("opens a submenu with ArrowRight and closes it with ArrowLeft", async () => {
    const onRed = vi.fn();
    mount(<Example onRed={onRed} />);
    await openMenu();
    await key("End");
    await key("ArrowRight");
    await settle();
    expect(byRole("menu")).toHaveLength(2);
    expect(document.activeElement?.textContent).toBe("Red");
    await key("ArrowLeft");
    await settle();
    expect(byRole("menu")).toHaveLength(1);
    expect(document.activeElement?.textContent).toContain("Label as");
  });

  it("selects with Enter, closes, and returns focus to the trigger", async () => {
    const onArchive = vi.fn();
    mount(<Example onArchive={onArchive} />);
    const trigger = await openMenu();
    await key("Enter");
    await settle();
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(byRole("menu")).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Escape", async () => {
    mount(<Example />);
    const trigger = await openMenu();
    await key("Escape");
    await settle();
    expect(byRole("menu")).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });

  it("marks destructive items and hides the shortcut hint from assistive tech", async () => {
    mount(<Example />);
    await openMenu();
    const destructive = byRole("menuitem").find((item) => item.textContent === "Delete");
    expect(destructive?.dataset.variant).toBe("destructive");
    expect(document.querySelector("kbd")?.getAttribute("aria-hidden")).toBe("true");
  });
});
