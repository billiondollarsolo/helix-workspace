// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DriveItemMenu, menuPointFromEvent, type DriveItemAction } from "./drive-item-menu";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("DriveItemMenu", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actions: DriveItemAction[] = [];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    actions.length = 0;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("offers copy, move, share, and hide for a shared file", () => {
    act(() => {
      root.render(
        <DriveItemMenu
          target={{
            id: "file-1",
            name: "Specs.pdf",
            kind: "file",
            starred: false,
            x: 20,
            y: 20,
          }}
          canHide
          onClose={() => undefined}
          onAction={(_id, action) => {
            actions.push(action);
          }}
        />,
      );
    });
    const labels = Array.from(container.querySelectorAll('[role="menuitem"]')).map(
      (item) => item.textContent,
    );
    expect(labels).toEqual([
      "Share",
      "Make a copy",
      "Move to…",
      "Star",
      "Move to trash",
      "Remove from Shared with me",
    ]);
    act(() => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        .find((button) => button.textContent === "Make a copy")
        ?.click();
    });
    expect(actions).toEqual(["copy"]);
  });

  it("omits copy and star for folders", () => {
    act(() => {
      root.render(
        <DriveItemMenu
          target={{
            id: "folder-1",
            name: "Engineering",
            kind: "folder",
            starred: false,
            x: 20,
            y: 20,
          }}
          canHide={false}
          onClose={() => undefined}
          onAction={() => undefined}
        />,
      );
    });
    const labels = Array.from(container.querySelectorAll('[role="menuitem"]')).map(
      (item) => item.textContent,
    );
    expect(labels).toEqual(["Share", "Move to…"]);
  });

  it("keeps the menu on screen", () => {
    const point = menuPointFromEvent({ clientX: 10_000, clientY: 10_000 });
    expect(point.x).toBeLessThan(10_000);
    expect(point.y).toBeLessThan(10_000);
  });
});
