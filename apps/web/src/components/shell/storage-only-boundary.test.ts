import { describe, expect, it } from "vitest";
import { notificationVisibleForBuild, routeForNotification } from "./notifications-panel";
import { assistantQuickPromptsForBuild } from "@/features/assistant/assistant-data";

describe("storage-only shell surfaces", () => {
  it("removes editor and collaboration quick prompts", () => {
    const text = assistantQuickPromptsForBuild(true)
      .flatMap((prompt) => [prompt.title, prompt.sub])
      .join(" ");
    expect(text).not.toMatch(/calendar|docs?|sheets?|slides?|meet/i);
    expect(text).toMatch(/mail/i);
    expect(text).toMatch(/drive/i);
    expect(text).toMatch(/chat/i);
  });

  it("hides Calendar and Meet activity and safely routes legacy file activity", () => {
    expect(notificationVisibleForBuild({ verb: "calendar.reminder" }, true)).toBe(false);
    expect(notificationVisibleForBuild({ verb: "meet.started" }, true)).toBe(false);
    expect(notificationVisibleForBuild({ verb: "docs.comment.created" }, true)).toBe(false);
    expect(notificationVisibleForBuild({ verb: "meet.recording.ready" }, true)).toBe(true);
    expect(routeForNotification({ verb: "meet.recording.ready" }, true)).toBe("/drive");
  });
});
