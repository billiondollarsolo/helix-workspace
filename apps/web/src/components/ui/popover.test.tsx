// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { axeViolations, byRole, click, key, mount, settle, unmountAll } from "@/test/ui";
import { Popover, PopoverAnchor, PopoverClose, PopoverContent, PopoverTrigger } from "./popover";

function Example() {
  return (
    <Popover>
      <PopoverAnchor asChild>
        <span>anchor</span>
      </PopoverAnchor>
      <PopoverTrigger>Snooze</PopoverTrigger>
      <PopoverContent aria-label="Snooze until">
        <button type="button">Later today</button>
        <PopoverClose>Done</PopoverClose>
      </PopoverContent>
    </Popover>
  );
}

describe("Popover", () => {
  afterEach(unmountAll);

  it("opens a labelled dialog, moves focus in, and passes axe", async () => {
    mount(<Example />);
    const trigger = byRole("button", "Snooze")[0] ?? document.querySelector("button");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    click(trigger ?? null);
    await settle();
    const dialog = byRole("dialog", "Snooze until")[0];
    expect(dialog).toBeDefined();
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(trigger?.getAttribute("aria-controls")).toBe(dialog?.id);
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(await axeViolations()).toEqual([]);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    mount(<Example />);
    const trigger = document.querySelector<HTMLButtonElement>("button");
    click(trigger);
    await settle();
    await key("Escape");
    expect(byRole("dialog")).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });

  it("closes from a PopoverClose control", async () => {
    mount(<Example />);
    click(document.querySelector("button"));
    await settle();
    click(
      Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Done") ?? null,
    );
    await settle();
    expect(byRole("dialog")).toHaveLength(0);
  });
});
