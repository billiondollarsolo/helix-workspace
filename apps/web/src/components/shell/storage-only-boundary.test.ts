import { describe, expect, it } from "vitest";
import { appForNotification } from "./notifications-panel";
import { ASSISTANT_QUICK_PROMPTS } from "@/features/assistant/assistant-data";

describe("storage-only shell surfaces", () => {
  it("removes editor and collaboration quick prompts", () => {
    const text = ASSISTANT_QUICK_PROMPTS.flatMap((prompt) => [prompt.title, prompt.sub]).join(" ");
    expect(text).not.toMatch(/calendar|docs?|sheets?|slides?|meet/i);
    expect(text).toMatch(/mail/i);
    expect(text).toMatch(/drive/i);
    expect(text).toMatch(/chat/i);
  });

  it("routes communication activity to its app", () => {
    expect(appForNotification({ verb: "meet.started" })?.route).toBe("/meet");
    expect(appForNotification({ verb: "calendar.reminder" })?.route).toBe("/calendar");
    expect(appForNotification({ verb: "drive.uploaded" })?.route).toBe("/drive");
    expect(appForNotification({ verb: "approval.requested" })).toBeUndefined();
  });
});
