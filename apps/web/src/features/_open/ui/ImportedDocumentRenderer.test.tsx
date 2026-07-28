// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectFormat } from "@helix/editors-format-loader";
import { ImportedDocumentRenderer } from "./ImportedDocumentRenderer";

vi.mock("@tiptap/react", () => ({
  useEditor: () => ({}),
  EditorContent: () => <div data-testid="editor" />,
}));

vi.mock("@tiptap/starter-kit", () => ({
  default: {},
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("ImportedDocumentRenderer", () => {
  it("uses valid disclosure markup for multiple import warnings", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ImportedDocumentRenderer
          objectId="object-1"
          fileName="report.docx"
          doc={{
            kind: "doc",
            format: detectFormat(
              "report.docx",
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ),
            tiptapDoc: { type: "doc", content: [{ type: "paragraph" }] },
            warnings: ["Primary warning", "Secondary warning"],
          }}
        />,
      );
    });

    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.parentElement?.tagName).toBe("DIV");
    expect(details?.querySelector(":scope > summary")?.textContent).toContain("+1 more");
    expect(container.querySelector("p details")).toBeNull();
  });
});
