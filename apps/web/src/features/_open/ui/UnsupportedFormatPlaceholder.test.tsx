// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnsupportedFormatPlaceholder } from "./UnsupportedFormatPlaceholder";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("UnsupportedFormatPlaceholder", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("leads unsupported legacy Office files with preview/download, not coming-soon copy", () => {
    act(() => {
      root.render(
        <UnsupportedFormatPlaceholder
          objectId="legacy-ppt"
          fileName="board.ppt"
          byteSize={2048}
          result={{
            kind: "unsupported",
            format: {
              id: "ppt-legacy",
              label: "PPT (legacy PowerPoint, binary)",
              surface: "slides",
              supported: false,
              trackingTask: "TASK-19",
            },
            reason:
              "PPT (legacy PowerPoint, binary) parsing is being built (tracked under TASK-19).",
          }}
        />,
      );
    });

    expect(container.textContent ?? "").toContain("Preview/download only");
    expect(container.textContent ?? "").toContain("Download original");
    expect(container.textContent ?? "").toContain("Microsoft PowerPoint");
    expect(container.textContent ?? "").not.toContain("support is coming soon");
  });
});
