// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { axeViolations, byRole, click, mount, settle, unmountAll } from "@/test/ui";
import { FormPanel } from "./form-panel";

function Example() {
  const [open, setOpen] = useState(true);
  const [count, setCount] = useState(0);
  return (
    <>
      <header>
        <button onClick={() => setCount((value) => value + 1)}>Workspace {count}</button>
      </header>
      {open ? (
        <FormPanel title={<h2>New item</h2>} onClose={() => setOpen(false)}>
          <label>
            Name
            <input defaultValue="Kept draft" />
          </label>
        </FormPanel>
      ) : null}
    </>
  );
}
describe("FormPanel", () => {
  afterEach(unmountAll);
  it("keeps the workspace usable and the draft open, with valid heading semantics", async () => {
    mount(<Example />);
    await settle();
    const dialog = byRole("dialog")[0]!;
    expect(dialog.getAttribute("aria-modal")).not.toBe("true");
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(document.activeElement).toBe(document.querySelector("input"));
    click(
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Workspace 0",
      )!,
    );
    await settle();
    expect(document.body.textContent).toContain("Workspace 1");
    expect(document.querySelector("input")?.value).toBe("Kept draft");
    expect(byRole("dialog")).toHaveLength(1);
    expect(await axeViolations()).toEqual([]);
  });
});
