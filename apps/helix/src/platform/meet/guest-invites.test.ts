import { describe, expect, it } from "vitest";
import {
  meetGuestInviteTokenHash,
  mintMeetGuestInviteToken,
  verifyMeetGuestInviteToken,
} from "./guest-invites.js";

const secret = "meet-guest-test-secret-that-is-long-enough";
const claims = {
  inviteId: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  roomId: "33333333-3333-4333-8333-333333333333",
  expiresAt: new Date("2026-09-03T00:00:00Z"),
};

describe("Meet guest invitations", () => {
  it("binds signed claims and rejects tampering and expiry", () => {
    const token = mintMeetGuestInviteToken(secret, claims);
    expect(verifyMeetGuestInviteToken(secret, token, new Date("2026-09-02T00:00:00Z"))).toEqual(
      claims,
    );
    expect(
      verifyMeetGuestInviteToken(secret, `${token}x`, new Date("2026-09-02T00:00:00Z")),
    ).toBeNull();
    expect(verifyMeetGuestInviteToken(secret, token, claims.expiresAt)).toBeNull();
    expect(meetGuestInviteTokenHash(token)).toMatch(/^[a-f0-9]{64}$/u);
  });
});
