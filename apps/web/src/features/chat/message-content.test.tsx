// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatAttachmentGallery,
  ChatMessageContent,
  applyCodeMarkup,
  parseFencedMarkdown,
} from "./message-content";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Chat Markdown and attachments", () => {
  it("renders fenced code with a language label, copy action, and no HTML injection", () => {
    const container = render(
      <ChatMessageContent
        body={'before `<img src=x>`\n```typescript\nconst value = "<script>";\n```'}
        bodyFormat="markdown"
      />,
    );
    expect(container.textContent).toContain("typescript");
    expect(container.textContent).toContain('const value = "<script>";');
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".chat-code-keyword")?.textContent).toBe("const");
    expect(container.querySelector('button[aria-label="Copy typescript code"]')).not.toBeNull();
  });

  it("parses fenced code and wraps selected inline or block code", () => {
    expect(parseFencedMarkdown("```sql\nselect 1;\n```")).toEqual([
      { kind: "code", value: "select 1;", language: "sql" },
    ]);
    expect(applyCodeMarkup("hello", 0, 5, "inline")).toEqual({
      value: "`hello`",
      selectionStart: 1,
      selectionEnd: 6,
    });
    expect(applyCodeMarkup("", 0, 0, "fenced").value).toBe("```\ncode\n```");
  });

  it("shows hidden Chat images inline with open, download, and Save to Drive actions", () => {
    const container = render(
      <ChatAttachmentGallery
        attachmentObjectIds={["44444444-4444-4444-8444-444444444444"]}
        attachments={[
          {
            objectId: "44444444-4444-4444-8444-444444444444",
            source: "chat",
            filename: "animated.gif",
            mimeType: "image/gif",
            byteSize: 42,
          },
        ]}
      />,
    );
    const image = container.querySelector<HTMLImageElement>("img");
    expect(image?.src).toContain(
      "/api/chat/attachments/44444444-4444-4444-8444-444444444444/content",
    );
    expect(container.textContent).toContain("Open");
    expect(container.textContent).toContain("Download");
    expect(container.textContent).toContain("Save to Drive");
  });
});

function render(node: ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(node);
  });
  return container;
}
