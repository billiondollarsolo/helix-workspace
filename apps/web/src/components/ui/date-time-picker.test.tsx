// @vitest-environment jsdom

import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axeViolations, byRole, click, key, mount, unmountAll } from "@/test/ui";
import { addMonths, monthGrid, startOfWeek, timeSlots } from "./date-time-math";
import { DateTimePicker } from "./date-time-picker";

function Controlled({
  initial,
  min,
  onChange = vi.fn(),
  mode,
}: {
  initial: Date | null;
  min?: Date;
  onChange?: (value: Date) => void;
  mode?: "date" | "datetime";
}) {
  const [value, setValue] = useState<Date | null>(initial);
  return (
    <DateTimePicker
      value={value}
      min={min}
      mode={mode}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

function focusedDay(): string | undefined {
  return document.activeElement?.getAttribute("aria-label") ?? undefined;
}

function dayButton(label: RegExp): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="grid"] button')).find(
    (button) => label.test(button.getAttribute("aria-label") ?? ""),
  );
}

describe("date-time math", () => {
  it("clamps month moves to the last day", () => {
    expect(addMonths(new Date(2026, 0, 31), 1).getDate()).toBe(28);
  });

  it("starts weeks on the requested day and fills six weeks", () => {
    expect(startOfWeek(new Date(2026, 9, 14), 1).getDate()).toBe(12);
    const grid = monthGrid(new Date(2026, 9, 14), 0);
    expect(grid).toHaveLength(6);
    expect(grid.every((week) => week.length === 7)).toBe(true);
  });

  it("builds time slots across the day", () => {
    expect(timeSlots(30)).toHaveLength(48);
    expect(timeSlots(15).at(-1)).toBe(23 * 60 + 45);
  });
});

describe("DateTimePicker", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 11, 10, 7));
  });
  afterEach(() => {
    unmountAll();
    vi.useRealTimers();
  });

  it("exposes a labelled grid, one tab stop, today, and a time listbox", async () => {
    mount(<Controlled initial={new Date(2026, 9, 14, 9, 0)} />);
    const grid = byRole("grid")[0];
    expect(grid?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(
      document.getElementById(grid?.getAttribute("aria-labelledby") ?? "")?.textContent,
    ).toMatch(/October 2026/);
    expect(grid?.querySelectorAll('button[tabindex="0"]')).toHaveLength(1);
    expect(grid?.querySelector('[aria-current="date"]')?.textContent).toBe("11");
    expect(grid?.querySelector('td[aria-selected="true"]')?.textContent).toBe("14");
    const listbox = byRole("listbox", "Time")[0];
    expect(listbox?.getAttribute("aria-activedescendant")).toBe(
      listbox?.querySelector('[aria-selected="true"]')?.id,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it("moves through days, weeks, and months with the keyboard and picks with Enter", async () => {
    const onChange = vi.fn();
    mount(<Controlled initial={new Date(2026, 9, 14, 9, 0)} onChange={onChange} />);
    dayButton(/October 14/)?.focus();
    await key("ArrowRight");
    expect(focusedDay()).toMatch(/October 15/);
    await key("ArrowDown");
    expect(focusedDay()).toMatch(/October 22/);
    await key("Home");
    expect(focusedDay()).toMatch(/Sunday, October 18/);
    await key("End");
    expect(focusedDay()).toMatch(/Saturday, October 24/);
    await key("PageDown");
    expect(focusedDay()).toMatch(/November 24/);
    await key("PageUp", { shiftKey: true });
    expect(focusedDay()).toMatch(/November 24, 2025/);
    await key("PageDown", { shiftKey: true });
    click(document.activeElement);
    const picked = onChange.mock.calls.at(-1)?.[0] as Date;
    expect(picked.getFullYear()).toBe(2026);
    expect(picked.getMonth()).toBe(10);
    expect(picked.getDate()).toBe(24);
    expect(picked.getHours()).toBe(9);
  });

  it("selects times with the arrow keys", async () => {
    const onChange = vi.fn();
    mount(<Controlled initial={new Date(2026, 9, 14, 9, 0)} onChange={onChange} />);
    const listbox = byRole("listbox", "Time")[0] ?? null;
    listbox?.focus();
    await key("ArrowDown");
    expect((onChange.mock.calls.at(-1)?.[0] as Date).getMinutes()).toBe(30);
    await key("End");
    expect((onChange.mock.calls.at(-1)?.[0] as Date).getHours()).toBe(23);
  });

  it("refuses days and times before min", () => {
    const onChange = vi.fn();
    const min = new Date(2026, 9, 11, 10, 7);
    mount(<Controlled initial={null} min={min} onChange={onChange} />);
    const yesterday = dayButton(/October 10/);
    expect(yesterday?.getAttribute("aria-disabled")).toBe("true");
    click(yesterday ?? null);
    expect(onChange).not.toHaveBeenCalled();
    click(dayButton(/October 11/) ?? null);
    const picked = onChange.mock.calls.at(-1)?.[0] as Date;
    expect(picked >= min).toBe(true);
    expect(picked.getHours()).toBe(10);
    expect(picked.getMinutes()).toBe(30);
    const early = byRole("option").find((option) => option.getAttribute("aria-disabled"));
    expect(early).toBeDefined();
  });

  it("hides the time list in date mode", () => {
    mount(<Controlled initial={null} mode="date" />);
    expect(byRole("listbox")).toHaveLength(0);
    expect(byRole("group")[0]?.getAttribute("aria-label")).toBe("Date");
  });
});
