// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AssistantMarkdown } from "./assistant-markdown";

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
afterEach(() => {
  act(() => root.unmount());
  container.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("renders CommonMark and partial fenced code without executing HTML or loading image URLs", () => {
  root = createRoot(container);
  act(() =>
    root.render(
      <AssistantMarkdown
        text={
          "# Heading\n\n**bold** and *emphasis* with `inline`\n\n- first\n- second\n\n[Safe](https://example.test) [bad](javascript:alert%281%29)\n\n![tracker](https://example.test/pixel)\n\n<script>alert(1)</script>\n\n```typescript\nconst answer = 42;"
        }
      />,
    ),
  );
  expect(container.querySelector("h1")?.textContent).toBe("Heading");
  expect(container.querySelector("strong")?.textContent).toBe("bold");
  expect(container.querySelectorAll("li")).toHaveLength(2);
  expect(container.querySelector(".message-code-keyword")?.textContent).toBe("const");
  expect(container.querySelector("script, img, iframe, [onclick]")).toBeNull();
  expect(container.querySelectorAll("a")).toHaveLength(1);
  expect(container.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
  expect(container.querySelector("pre code")?.textContent).toBe("const answer = 42;");
});

it("copies the original fenced code and makes clipboard failures actionable", async () => {
  const writeText = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("denied"));
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  root = createRoot(container);
  act(() => root.render(<AssistantMarkdown text={'```js\nconst answer = "<tag>";\n```'} />));
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Copy js code"]');
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
  expect(writeText).toHaveBeenCalledWith('const answer = "<tag>";');
  expect(button?.textContent).toBe("Copied");
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("copy it manually");
});

it("renders streamed GFM tables with headers, inline formatting and safe source links", () => {
  root = createRoot(container);
  const partial = "| Element | Details |\n| --- | --- |\n| High | **80°F** |";
  act(() => root.render(<AssistantMarkdown text={partial} />));
  expect([...container.querySelectorAll("th")].map((node) => node.textContent)).toEqual([
    "Element",
    "Details",
  ]);
  expect(container.querySelector("td strong")?.textContent).toBe("80°F");
  act(() =>
    root.render(
      <AssistantMarkdown
        text={`${partial}\n| Source | [Forecast](https://weather.example/forecast) |\n| Unsafe | <script>alert(1)</script> ![pixel](https://tracker.example/image) [bad](javascript:alert(1)) |`}
      />,
    ),
  );
  expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
  expect(
    container
      .querySelector('[role="region"][aria-label="Response table"]')
      ?.getAttribute("tabindex"),
  ).toBe("0");
  expect(container.querySelector("table a")?.getAttribute("href")).toBe(
    "https://weather.example/forecast",
  );
  expect(container.querySelectorAll("table a")).toHaveLength(1);
  expect(container.querySelector("script,img,iframe")).toBeNull();
});
