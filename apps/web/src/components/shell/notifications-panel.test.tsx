// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";
import { NotificationsPanel, formatRelativeNotificationTime } from "./notifications-panel";

const navigate = vi.fn();
const markRead = vi.fn();
const markAllRead = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
}));

vi.mock("@/features/notifications/api", () => ({
  notificationsListQueryOptions: () => ({ queryKey: ["notifications"] }),
  useMarkRead: () => ({ mutate: markRead }),
  useMarkAllRead: () => ({ mutate: markAllRead, isPending: false }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("NotificationsPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(useQuery).mockReturnValue({
      data: {
        items: [
          {
            id: "notification-1",
            verb: "docs.comment.created",
            summary: "Morgan mentioned you",
            body: "Review the launch brief",
            createdAt: "2026-07-28T12:00:00.000Z",
            unread: true,
          },
        ],
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as never);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders focus-managed tabs and accessible locale-aware timestamps", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    act(() => {
      root.render(<NotificationsPanel open onClose={() => undefined} />);
    });
    await act(async () => Promise.resolve());

    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(container.querySelector('[role="tabpanel"]')).not.toBeNull();
    const time = container.querySelector("time");
    expect(time?.dateTime).toBe("2026-07-28T12:00:00.000Z");
    expect(time?.title.length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(
      container.querySelector<HTMLButtonElement>("button:not([disabled])"),
    );

    act(() => root.render(<NotificationsPanel open={false} onClose={() => undefined} />));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("formats past and future values without hardcoded English abbreviations", () => {
    const now = Date.parse("2026-07-28T12:05:00.000Z");
    expect(formatRelativeNotificationTime("2026-07-28T12:00:00.000Z", now, "en-US").relative).toBe(
      "5 minutes ago",
    );
    expect(formatRelativeNotificationTime("2026-07-29T12:05:00.000Z", now, "en-US").relative).toBe(
      "tomorrow",
    );
  });
});
