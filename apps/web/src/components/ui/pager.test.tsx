// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, click, mount, unmountAll } from "@/test/ui";
import { Pager, pagerRange } from "./pager";

const noop = () => undefined;

describe("pagerRange", () => {
  it("formats the visible range with grouping", () => {
    expect(pagerRange({ start: 0, pageCount: 50, total: 1234 })).toBe("1–50 of 1,234");
    expect(pagerRange({ start: 1200, pageCount: 34, total: 1234 })).toBe("1,201–1,234 of 1,234");
    expect(pagerRange({ start: 50, pageCount: 50, total: undefined })).toBe("51–100 of many");
  });

  it("has no range for an empty list", () => {
    expect(pagerRange({ start: 0, pageCount: 0, total: 0 })).toBeNull();
  });
});

describe("Pager", () => {
  afterEach(unmountAll);

  it("renders a labelled navigation with Newer/Older buttons", async () => {
    const next = vi.fn();
    mount(<Pager start={0} pageCount={50} total={1234} onPrevious={noop} onNext={next} />);
    const nav = document.querySelector("nav");
    expect(nav?.getAttribute("aria-label")).toBe("Pagination");
    expect(nav?.textContent).toContain("1–50 of 1,234");
    const [newer, older] = Array.from(document.querySelectorAll("button"));
    expect(newer?.getAttribute("aria-label")).toBe("Newer");
    expect(newer?.disabled).toBe(true);
    expect(older?.disabled).toBe(false);
    click(older ?? null);
    expect(next).toHaveBeenCalledTimes(1);
    expect(await axeViolations()).toEqual([]);
  });

  it("disables Older on the last page and Newer stays enabled", () => {
    mount(<Pager start={1200} pageCount={34} total={1234} onPrevious={noop} onNext={noop} />);
    const [newer, older] = Array.from(document.querySelectorAll("button"));
    expect(newer?.disabled).toBe(false);
    expect(older?.disabled).toBe(true);
  });

  it("follows hasMore when the total is unknown", () => {
    mount(
      <Pager start={0} pageCount={50} total={undefined} hasMore onPrevious={noop} onNext={noop} />,
    );
    expect(document.querySelectorAll("button")[1]?.disabled).toBe(false);
  });

  it("renders nothing for an empty list and a placeholder while loading", () => {
    const empty = mount(
      <Pager start={0} pageCount={0} total={0} onPrevious={noop} onNext={noop} />,
    );
    expect(empty.container.innerHTML).toBe("");
    empty.unmount();
    mount(
      <Pager start={0} pageCount={0} total={undefined} loading onPrevious={noop} onNext={noop} />,
    );
    expect(document.body.textContent).not.toContain("No results");
    expect(Array.from(document.querySelectorAll("button")).every((b) => b.disabled)).toBe(true);
  });
});
