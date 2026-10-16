// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, click, mount, settle, unmountAll } from "@/test/ui";
import { SetupGuides } from "./setup-guides";

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe("administrator setup guides", () => {
  it("offers public guides and copies the instructions URL for this installation", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { container } = mount(<SetupGuides />);
    expect(container.querySelector('a[href$="/admin-setup.md"]')).not.toBeNull();
    expect(container.querySelector('a[href$="/agent-setup.md"]')).not.toBeNull();
    click(container.querySelector("button"));
    await settle();
    expect(writeText).toHaveBeenCalledWith(new URL("/agent-setup.md", window.location.origin).href);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("copied");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("gives an actionable fallback when clipboard access is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const { container } = mount(<SetupGuides />);
    click(container.querySelector("button"));
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("copy its address");
  });
});
