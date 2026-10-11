// @vitest-environment jsdom

import { Inbox } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, byRole, click, mount, unmountAll } from "@/test/ui";
import { EmptyState } from "./empty-state";
import { InlineError } from "./inline-error";
import { Skeleton } from "./skeleton";

describe("Skeleton", () => {
  afterEach(unmountAll);

  it.each(["row", "card", "text"] as const)(
    "draws %s placeholders inside one labelled status region",
    async (variant) => {
      mount(<Skeleton variant={variant} count={4} label="Loading files" />);
      const [status] = byRole("status");
      expect(status?.getAttribute("aria-label")).toBe("Loading files");
      expect(status?.dataset.variant).toBe(variant);
      expect(status?.querySelectorAll(':scope > [aria-hidden="true"]')).toHaveLength(4);
      expect(await axeViolations()).toEqual([]);
    },
  );
});

describe("EmptyState", () => {
  afterEach(unmountAll);

  it("renders a heading at the requested level, body, and action", async () => {
    const compose = vi.fn();
    mount(
      <main>
        <h1>Mail</h1>
        <EmptyState
          icon={<Inbox />}
          title="No conversations"
          body="Archived messages are in All mail."
          action={
            <button type="button" onClick={compose}>
              Compose
            </button>
          }
        />
      </main>,
    );
    expect(document.querySelector("h2")?.textContent).toBe("No conversations");
    expect(document.body.textContent).toContain("Archived messages are in All mail.");
    expect(
      document.querySelector('[data-slot="empty-state"] svg')?.closest("[aria-hidden]"),
    ).not.toBeNull();
    click(document.querySelector("button"));
    expect(compose).toHaveBeenCalledTimes(1);
    expect(await axeViolations()).toEqual([]);
  });

  it("supports a nested heading level", () => {
    mount(<EmptyState title="Nothing here" headingLevel={3} size="inline" />);
    expect(document.querySelector("h3")?.textContent).toBe("Nothing here");
  });
});

describe("InlineError", () => {
  afterEach(unmountAll);

  it("announces the failure and retries", async () => {
    const retry = vi.fn();
    mount(
      <InlineError
        title="Couldn't load conversations"
        message="The server timed out."
        onRetry={retry}
      />,
    );
    const [alert] = byRole("alert");
    expect(alert?.textContent).toContain("Couldn't load conversations");
    expect(alert?.textContent).toContain("The server timed out.");
    click(document.querySelector("button"));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(await axeViolations()).toEqual([]);
  });

  it("disables Retry while retrying and renders extra actions", () => {
    mount(
      <InlineError
        message="Offline"
        onRetry={vi.fn()}
        retrying
        actions={<button type="button">Open settings</button>}
        variant="compact"
      />,
    );
    const retry = document.querySelector("button");
    expect(retry?.disabled).toBe(true);
    expect(retry?.getAttribute("aria-busy")).toBe("true");
    expect(document.querySelectorAll("button")[1]?.textContent).toBe("Open settings");
  });

  it("omits Retry when there is nothing to retry", () => {
    mount(<InlineError message="Permission denied" />);
    expect(document.querySelector("button")).toBeNull();
  });
});
