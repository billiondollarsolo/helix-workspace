// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";
import { NotificationsPanel, formatRelativeNotificationTime } from "./notifications-panel";

const navigate = vi.fn();
const markRead = vi.fn();
const markAllRead = vi.fn();
const invalidateQueries = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
  // The Retry button invalidates the shared notifications key rather than
  // calling this observer's own `refetch`, so the panel needs a client.
  useQueryClient: () => ({ invalidateQueries: invalidateQueries }),
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
            verb: "drive.comment.created",
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

  it("groups by app, marks unread rows, and offers Mark all read", async () => {
    const item = (id: string, verb: string, unread: boolean) => ({
      id,
      verb,
      summary: `${verb} summary`,
      body: null,
      createdAt: "2026-07-28T12:00:00.000Z",
      unread,
    });
    vi.mocked(useQuery).mockReturnValue({
      data: {
        items: [
          item("1", "chat.mention", true),
          item("2", "mail.received", false),
          item("3", "approval.requested", true),
          item("4", "mail.received", true),
        ],
      },
      isLoading: false,
      isError: false,
      isFetching: false,
    } as never);
    act(() => root.render(<NotificationsPanel open onClose={() => undefined} />));
    await act(async () => Promise.resolve());

    const headings = Array.from(container.querySelectorAll("h3")).map((h) => h.textContent);
    expect(headings).toEqual(["Mail", "Chat", "Helix"]);
    expect(container.querySelectorAll(".notification-dot")).toHaveLength(3);
    expect(container.querySelector('[role="tab"][aria-selected="false"]')?.textContent).toBe(
      "Unread (3)",
    );

    const markAll = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Mark all read",
    );
    expect(markAll?.disabled).toBe(false);
    act(() => markAll?.click());
    expect(markAllRead).toHaveBeenCalledTimes(1);

    const mailRow = container.querySelector<HTMLButtonElement>(".notification-row.unread");
    act(() => mailRow?.click());
    expect(markRead).toHaveBeenCalledWith(["4"]);
    expect(navigate).toHaveBeenCalledWith({ to: "/mail" });
  });

  it("shows an empty state when everything is read", async () => {
    vi.mocked(useQuery).mockReturnValue({
      data: { items: [] },
      isLoading: false,
      isError: false,
      isFetching: false,
    } as never);
    act(() => root.render(<NotificationsPanel open onClose={() => undefined} />));
    await act(async () => Promise.resolve());
    expect(container.textContent).toContain("You’re all caught up");
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
