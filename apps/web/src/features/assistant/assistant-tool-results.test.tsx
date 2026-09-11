// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantSourceList, AssistantToolActivityList } from "./assistant-tool-results";

describe("Assistant tool results", () => {
  it("labels actual page reads separately from search links and rejects unsafe URLs", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <AssistantSourceList
        sources={[
          {
            id: "search",
            type: "web.search",
            title: "Search <script>title</script>",
            url: "https://example.com/search?q=weather",
          },
          { id: "page", type: "web.fetch", url: "https://example.com/forecast" },
          ...[
            "javascript:alert(1)",
            "file:///tmp/file",
            "https://user:secret@example.com/",
            "invalid",
          ].map((url, index) => ({ id: String(index), type: "web.fetch", url })),
          { id: "workspace", type: "drive", url: "https://example.com/private" },
        ]}
      />,
    );
    expect(container.querySelectorAll("a")).toHaveLength(2);
    expect(container.querySelector("a")?.href).toBe("https://example.com/search?q=weather");
    expect(container.querySelector("a")?.rel).toBe("noopener noreferrer");
    expect(container.querySelectorAll("script,img")).toHaveLength(0);
    expect(container.textContent).toContain("Search result");
    expect(container.textContent).toContain("Read page");
    expect(renderToStaticMarkup(<AssistantSourceList sources={[]} />)).toBe("");
  });

  it("keeps pending approval, failure and interruption distinct from completion", () => {
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
    expect(
      [...container.querySelectorAll('[role="status"]')].map((node) => node.textContent),
    ).toEqual(["Running", "Completed", "Failed", "Skipped", "Needs approval"]);
    expect(container.textContent).toContain("Access revoked.");
    expect(
      renderToStaticMarkup(<AssistantToolActivityList activity={activity} streaming={false} />),
    ).toContain("Interrupted");
    expect(
      renderToStaticMarkup(<AssistantToolActivityList activity={[]} streaming={false} />),
    ).toBe("");
  });
});
