import { describe, expect, it, vi } from "vitest";
import {
  fetchOnboardingState,
  saveOnboardingProgress,
  sendOnboardingEvent,
  sendOnboardingInvites,
} from "./api";
import type { AuthFetch } from "@/lib/auth";

describe("onboarding api", () => {
  it("loads authenticated onboarding recovery state", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(
      Response.json({
        status: "in_progress",
        currentStep: "sso",
        planChoice: "personal",
        inviteCount: 2,
        identityChoice: "google",
        updatedAt: "2026-05-24T12:00:00.000Z",
      }),
    );

    await expect(fetchOnboardingState(fetchImpl)).resolves.toEqual({
      status: "in_progress",
      currentStep: "sso",
      planChoice: "personal",
      inviteCount: 2,
      identityChoice: "google",
      updatedAt: "2026-05-24T12:00:00.000Z",
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/signup/onboarding-state", {
      method: "GET",
      credentials: "include",
    });
  });

  it("sends authenticated onboarding telemetry", async () => {
    const fetchImpl = vi
      .fn<AuthFetch>()
      .mockResolvedValue(Response.json({ status: "accepted" }, { status: 202 }));

    await sendOnboardingEvent(
      {
        event: "completed",
        planChoice: "pro-trial",
        inviteCount: 2,
        identityChoice: "local",
        skipped: false,
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith("/api/signup/onboarding-event", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "completed",
        planChoice: "pro-trial",
        inviteCount: 2,
        identityChoice: "local",
        skipped: false,
      }),
    });
  });

  it("surfaces failed telemetry writes", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(Response.json({}, { status: 503 }));

    await expect(sendOnboardingEvent({ event: "started" }, fetchImpl)).rejects.toThrow(
      "Failed to record onboarding event (503).",
    );
  });

  it("saves progress without raw invite emails", async () => {
    const fetchImpl = vi
      .fn<AuthFetch>()
      .mockResolvedValue(Response.json({ status: "accepted" }, { status: 202 }));

    await saveOnboardingProgress(
      {
        currentStep: "invite",
        planChoice: "pro-trial",
        inviteCount: 2,
        identityChoice: "local",
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith("/api/signup/onboarding-progress", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        currentStep: "invite",
        planChoice: "pro-trial",
        inviteCount: 2,
        identityChoice: "local",
      }),
    });
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain("ada@example.com");
  });

  it("sends raw invite emails only to the onboarding invites endpoint", async () => {
    const fetchImpl = vi
      .fn<AuthFetch>()
      .mockResolvedValue(Response.json({ status: "accepted", inviteCount: 2 }, { status: 202 }));

    await sendOnboardingInvites({ emails: ["ada@example.com", "grace@example.com"] }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("/api/signup/onboarding-invites", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emails: ["ada@example.com", "grace@example.com"] }),
    });
  });

  it("surfaces failed invite delivery requests", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(Response.json({}, { status: 503 }));

    await expect(sendOnboardingInvites({ emails: ["ada@example.com"] }, fetchImpl)).rejects.toThrow(
      "Failed to send onboarding invites (503).",
    );
  });
});
