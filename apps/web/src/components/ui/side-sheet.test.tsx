// @vitest-environment jsdom

import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { axeViolations, byRole, click, key, mount, settle, unmountAll } from "@/test/ui";
import { SideSheet } from "./side-sheet";

function Example() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Details
      </button>
      <SideSheet
        modal
        open={open}
        onOpenChange={setOpen}
        title="File details"
        description="Owner, sharing, and activity"
        footer={<button type="button">Save</button>}
      >
        <label>
          Name <input defaultValue="Plan" />
        </label>
      </SideSheet>
    </>
  );
}

describe("SideSheet", () => {
  afterEach(unmountAll);

  it("opens as a labelled modal dialog with focus inside", async () => {
    mount(<Example />);
    click(document.querySelector("button"));
    await settle();
    const [dialog] = byRole("dialog");
    expect(dialog).toBeDefined();
    const title = document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "");
    expect(title?.textContent).toBe("File details");
    const description = document.getElementById(dialog?.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("Owner, sharing, and activity");
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(await axeViolations()).toEqual([]);
  });

  it("traps Tab inside the sheet", async () => {
    mount(<Example />);
    click(document.querySelector("button"));
    await settle();
    const dialog = byRole("dialog")[0];
    const save = Array.from(dialog?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "Save",
    );
    save?.focus();
    await key("Tab");
    expect(dialog?.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape and from the Close button, restoring focus", async () => {
    mount(<Example />);
    const opener = document.querySelector("button");
    opener?.focus();
    click(opener);
    await settle();
    await key("Escape");
    expect(byRole("dialog")).toHaveLength(0);
    expect(document.activeElement).toBe(opener);

    click(opener);
    await settle();
    click(document.querySelector('button[aria-label="Close"]'));
    await settle();
    expect(byRole("dialog")).toHaveLength(0);
  });
});
