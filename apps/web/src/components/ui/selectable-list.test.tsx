// @vitest-environment jsdom

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, byRole, click, key, mount, unmountAll } from "@/test/ui";
import {
  keyRange,
  SelectableList,
  SelectAllCheckbox,
  type SelectableRowState,
} from "./selectable-list";

interface Thread {
  id: string;
  subject: string;
}

const THREADS: Thread[] = ["a", "b", "c", "d", "e"].map((id) => ({
  id,
  subject: `Subject ${id.toUpperCase()}`,
}));

function Example({
  onOpen = vi.fn(),
  onSelectAll,
  onStar = vi.fn(),
}: {
  onOpen?: (thread: Thread) => void;
  onSelectAll?: () => void;
  onStar?: (thread: Thread) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return (
    <>
      <SelectAllCheckbox
        total={THREADS.length}
        selectedCount={selected.size}
        onToggle={(all) => setSelected(all ? new Set(THREADS.map((t) => t.id)) : new Set())}
      />
      <output data-testid="selected">{[...selected].sort().join(",")}</output>
      <SelectableList
        items={THREADS}
        getKey={(thread) => thread.id}
        getItemLabel={(thread) => thread.subject}
        label="Conversations"
        selectedKeys={selected}
        onSelectedKeysChange={setSelected}
        onOpen={onOpen}
        onSelectAll={onSelectAll}
        renderItem={(thread: Thread, state: SelectableRowState) => (
          <>
            <button
              type="button"
              tabIndex={state.tabIndex}
              aria-label={`Star ${thread.subject}`}
              onClick={() => onStar(thread)}
            >
              ☆
            </button>
            <span>{thread.subject}</span>
          </>
        )}
      />
    </>
  );
}

const rows = () => byRole("row");
const selectedText = () => document.querySelector("output")?.textContent ?? "";
const checkbox = (index: number) =>
  rows()[index]?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;

describe("keyRange", () => {
  it("returns the inclusive range in list order either way", () => {
    expect(keyRange(["a", "b", "c", "d"], "b", "d")).toEqual(["b", "c", "d"]);
    expect(keyRange(["a", "b", "c", "d"], "d", "b")).toEqual(["b", "c", "d"]);
    expect(keyRange(["a"], "z", "a")).toEqual(["a"]);
  });
});

describe("SelectableList", () => {
  afterEach(unmountAll);

  it("renders a multi-selectable grid with one tab stop and no nested interactive rows", async () => {
    mount(<Example />);
    const [grid] = byRole("grid");
    expect(grid?.getAttribute("aria-label")).toBe("Conversations");
    expect(grid?.getAttribute("aria-multiselectable")).toBe("true");
    expect(rows()).toHaveLength(5);
    expect(rows().filter((row) => row.tabIndex === 0)).toHaveLength(1);
    expect(rows().every((row) => row.tagName !== "BUTTON" && !row.closest("button"))).toBe(true);
    expect(checkbox(0)?.getAttribute("aria-label")).toBe("Select Subject A");
    expect(await axeViolations()).toEqual([]);
  });

  it("moves with j/k and arrows, Home/End, and keeps one tab stop", async () => {
    mount(<Example />);
    rows()[0]?.focus();
    await key("j");
    expect(document.activeElement).toBe(rows()[1]);
    await key("ArrowDown");
    expect(document.activeElement).toBe(rows()[2]);
    await key("k");
    expect(document.activeElement).toBe(rows()[1]);
    await key("End");
    expect(document.activeElement).toBe(rows()[4]);
    await key("ArrowDown");
    expect(document.activeElement).toBe(rows()[4]);
    await key("Home");
    expect(document.activeElement).toBe(rows()[0]);
    expect(rows().filter((row) => row.tabIndex === 0)).toEqual([rows()[0]]);
    expect(rows()[0]?.querySelector("button")?.tabIndex).toBe(0);
    expect(rows()[1]?.querySelector("button")?.tabIndex).toBe(-1);
  });

  it("toggles with x and Space, extends with Shift+j, clears with Escape", async () => {
    mount(<Example />);
    rows()[0]?.focus();
    await key("x");
    expect(selectedText()).toBe("a");
    expect(rows()[0]?.getAttribute("aria-selected")).toBe("true");
    await key("J", { shiftKey: true });
    await key("J", { shiftKey: true });
    expect(selectedText()).toBe("a,b,c");
    await key(" ");
    expect(selectedText()).toBe("a,b");
    await key("Escape");
    expect(selectedText()).toBe("");
  });

  it("opens with Enter, o, and a plain click, but not from inner controls", async () => {
    const onOpen = vi.fn();
    const onStar = vi.fn();
    mount(<Example onOpen={onOpen} onStar={onStar} />);
    rows()[1]?.focus();
    await key("Enter");
    await key("o");
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenLastCalledWith(THREADS[1]);
    click(rows()[3]?.querySelector("span") ?? null);
    expect(onOpen).toHaveBeenLastCalledWith(THREADS[3]);
    click(rows()[2]?.querySelector("button") ?? null);
    expect(onStar).toHaveBeenCalledWith(THREADS[2]);
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it("selects a range with Shift-click on checkboxes and rows, toggles with Ctrl-click", () => {
    mount(<Example />);
    click(checkbox(1));
    expect(selectedText()).toBe("b");
    click(checkbox(3), { shiftKey: true });
    expect(selectedText()).toBe("b,c,d");
    click(rows()[4]?.querySelector("span") ?? null, { shiftKey: true });
    expect(selectedText()).toBe("b,c,d,e");
    click(rows()[0]?.querySelector("span") ?? null, { ctrlKey: true });
    expect(selectedText()).toBe("a,b,c,d,e");
  });

  it("selects all with Ctrl+A, or delegates to onSelectAll", async () => {
    mount(<Example />);
    rows()[0]?.focus();
    await key("a", { ctrlKey: true });
    expect(selectedText()).toBe("a,b,c,d,e");
    unmountAll();

    const onSelectAll = vi.fn();
    mount(<Example onSelectAll={onSelectAll} />);
    rows()[0]?.focus();
    await key("a", { metaKey: true });
    expect(onSelectAll).toHaveBeenCalledTimes(1);
    expect(selectedText()).toBe("");
  });

  it("drives a tri-state select-all checkbox", () => {
    mount(<Example />);
    const all = document.querySelector<HTMLInputElement>('input[aria-label="Select all"]');
    click(checkbox(0));
    expect(all?.indeterminate).toBe(true);
    expect(all?.checked).toBe(false);
    click(all);
    expect(selectedText()).toBe("a,b,c,d,e");
    expect(all?.checked).toBe(true);
    expect(all?.indeterminate).toBe(false);
    click(all);
    expect(selectedText()).toBe("");
  });
});
