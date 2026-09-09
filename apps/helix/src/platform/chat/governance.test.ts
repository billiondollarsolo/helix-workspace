import { describe, expect, it } from "vitest";
import {
  canInviteChatGuest,
  canPostToChatSpace,
  chatGovernanceMetadata,
  chatMessageIsInRetention,
  readChatGovernance,
  shouldNotifyChatMember,
} from "./governance.js";

describe("Chat governance", () => {
  it("enforces posting and external-member policy for every shipped space type", () => {
    expect(canPostToChatSpace("conversation", "member")).toBe(true);
    expect(canPostToChatSpace("direct", "member")).toBe(true);
    expect(canPostToChatSpace("project", "member")).toBe(true);
    expect(canPostToChatSpace("announcement", "member")).toBe(false);
    expect(canPostToChatSpace("announcement", "moderator")).toBe(true);
    expect(canInviteChatGuest("internal", "external")).toBe(false);
    expect(canInviteChatGuest("guests", "external")).toBe(true);
    expect(canInviteChatGuest("guests", "partner")).toBe(false);
    expect(canInviteChatGuest("federated", "partner")).toBe(true);
  });

  it("normalizes direct rooms and applies notification, retention, and hold settings", () => {
    const metadata = chatGovernanceMetadata("chat_dm", {
      spaceType: "announcement",
      historyPolicy: "since_join",
      retentionDays: 30,
      notificationPolicy: "mentions",
      externalAccess: "federated",
    });
    expect(readChatGovernance("chat_dm", metadata)).toMatchObject({
      spaceType: "direct",
      historyPolicy: "since_join",
      retentionDays: 30,
      notificationPolicy: "mentions",
      externalAccess: "federated",
    });
    expect(shouldNotifyChatMember("mentions", "member", "sender", ["member"])).toBe(true);
    expect(shouldNotifyChatMember("mentions", "other", "sender", ["member"])).toBe(false);
    expect(
      chatMessageIsInRetention(
        { retentionDays: 1, legalHold: false },
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-01-03T00:00:00Z"),
      ),
    ).toBe(false);
    expect(
      chatMessageIsInRetention(
        { retentionDays: 1, legalHold: true },
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-01-03T00:00:00Z"),
      ),
    ).toBe(true);
  });
});
