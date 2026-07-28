import { describe, expect, it } from "vitest";
import {
  notificationsListQueryOptions,
  unreadCountQueryOptions,
} from "@/features/notifications/api";

describe("notification query options", () => {
  it("keeps the optional notification panel failure inside the panel", () => {
    expect(notificationsListQueryOptions().throwOnError).toBe(false);
  });

  it("does not let the unread badge take down the active workspace", () => {
    expect(unreadCountQueryOptions().throwOnError).toBe(false);
  });
});
