// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, byRole, click, key, mount, settle, unmountAll } from "@/test/ui";
import { MenuItem } from "./menu";
import { SplitButton } from "./split-button";

describe("SplitButton", () => {
  afterEach(unmountAll);

  it("runs the main action and opens the alternatives from the arrow", async () => {
    const send = vi.fn();
    const schedule = vi.fn();
    mount(
      <SplitButton label="Send" onClick={send} menuLabel="More send options">
        <MenuItem onSelect={schedule}>Schedule send</MenuItem>
      </SplitButton>,
    );
    const [main, arrow] = Array.from(document.querySelectorAll("button"));
    expect(byRole("group")).toHaveLength(1);
    click(main ?? null);
    expect(send).toHaveBeenCalledTimes(1);

    expect(arrow?.getAttribute("aria-label")).toBe("More send options");
    expect(arrow?.getAttribute("aria-haspopup")).toBe("menu");
    arrow?.focus();
    await key("Enter");
    expect(byRole("menu")).toHaveLength(1);
    expect(document.activeElement?.textContent).toBe("Schedule send");
    expect(await axeViolations()).toEqual([]);
    await key("Enter");
    expect(schedule).toHaveBeenCalledTimes(1);
    await settle();
    expect(document.activeElement).toBe(arrow);
  });

  it("can disable only the main action", () => {
    mount(
      <SplitButton label="Send" onClick={vi.fn()} menuLabel="More send options" actionDisabled>
        <MenuItem>Schedule send</MenuItem>
      </SplitButton>,
    );
    const [main, arrow] = Array.from(document.querySelectorAll("button"));
    expect(main?.disabled).toBe(true);
    expect(arrow?.disabled).toBe(false);
  });

  it("disables both halves", () => {
    mount(
      <SplitButton label="Send" onClick={vi.fn()} menuLabel="More send options" disabled>
        <MenuItem>Schedule send</MenuItem>
      </SplitButton>,
    );
    expect(Array.from(document.querySelectorAll("button")).every((b) => b.disabled)).toBe(true);
  });
});
