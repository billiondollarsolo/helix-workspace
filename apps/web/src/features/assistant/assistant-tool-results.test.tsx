// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AssistantEvidenceDrawer,
  AssistantSourceList,
  AssistantToolActivityList,
  publicWebSources,
} from "./assistant-tool-results";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("Assistant tool results", () => {
  it("keeps compact host chips and rejects unsafe URLs", () => {
    const sources = [
      {
        id: "search",
        type: "web.search",
        title: "Search <script>title</script>",
        url: "https://www.example.com/search?q=weather",
      },
      { id: "page", type: "web.fetch", url: "https://example.com/forecast" },
      ...[
        "javascript:alert(1)",
        "file:///tmp/file",
        "https://user:secret@example.com/",
        "invalid",
      ].map((url, index) => ({ id: String(index), type: "web.fetch", url })),
      { id: "workspace", type: "drive", url: "https://example.com/private" },
    ];
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <AssistantSourceList sources={sources} onOpenEvidence={() => undefined} />,
    );
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.querySelector('[aria-label="Sources"]')?.textContent).toContain(
      "1 example.com",
    );
    expect(container.textContent).toContain("Evidence");
    expect(container.textContent).not.toContain("Read page");
    expect(container.textContent).not.toContain("web_fetch");
    expect(container.querySelectorAll("script,img")).toHaveLength(0);
    expect(
      renderToStaticMarkup(<AssistantSourceList sources={[]} onOpenEvidence={() => undefined} />),
    ).toBe("");
    expect(publicWebSources(sources)).toHaveLength(2);
  });

  it("opens evidence links in the drawer", () => {
    const rootContainer = document.createElement("div");
    document.body.append(rootContainer);
    const root = createRoot(rootContainer);
    const sources = publicWebSources([
      {
        id: "search",
        type: "web.search",
        title: "Forecast search result",
        url: "https://weather.example/search",
      },
      {
        id: "page",
        type: "web.fetch",
        title: "Forecast page read",
        url: "https://weather.example/forecast",
      },
    ]);
    const onClose = vi.fn();
    act(() => {
      root.render(<AssistantEvidenceDrawer sources={sources} onClose={onClose} />);
    });
    const links = [...rootContainer.querySelectorAll("a")];
    expect(links).toHaveLength(2);
    expect(links[1]?.href).toBe("https://weather.example/forecast");
    expect(links[1]?.rel).toBe("noopener noreferrer");
    expect(rootContainer.textContent).toContain("Forecast page read");
    expect(rootContainer.textContent).not.toContain("Read page");
    act(() => {
      rootContainer.querySelector<HTMLButtonElement>('[aria-label="Close evidence"]')?.click();
    });
    expect(onClose).toHaveBeenCalledOnce();
    act(() => {
      root.unmount();
    });
    rootContainer.remove();
  });

  it("collapses completed tools and keeps pending, failure and interruption distinct", () => {
    const activity = ["running", "executed", "failed", "skipped", "pending_confirmation"].map(
      (status, index) => ({
        toolCallId: String(index),
        toolId: index === 0 ? "web.search" : "calendar.create",
        status: status as "running" | "executed" | "failed" | "skipped" | "pending_confirmation",
        ...(status === "failed" ? { error: "Access revoked." } : {}),
      }),
    );
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <AssistantToolActivityList activity={activity} streaming={true} />,
    );
    expect(container.querySelector("summary")?.textContent).toContain("Thinking");
    expect(container.querySelector("details")?.open).toBe(true);
    expect(
      [...container.querySelectorAll('[role="status"]')].map((node) => node.textContent),
    ).toEqual(["Running", "Completed", "Failed", "Skipped", "Needs approval"]);
    expect(container.textContent).toContain("Access revoked.");
    expect(
      renderToStaticMarkup(<AssistantToolActivityList activity={activity} streaming={false} />),
    ).toContain("Interrupted");
    const done = renderToStaticMarkup(
      <AssistantToolActivityList
        activity={[{ toolCallId: "1", toolId: "web.search", status: "executed" }]}
        streaming={false}
      />,
    );
    expect(done).toContain("1 tool");
    expect(done).not.toMatch(/<details[^>]*\sopen/u);
    expect(
      renderToStaticMarkup(<AssistantToolActivityList activity={[]} streaming={false} />),
    ).toBe("");
  });
});
