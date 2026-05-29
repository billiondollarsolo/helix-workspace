import { describe, expect, it, vi } from "vitest";
import { sendWelcomeActivationEvent } from "./api";
import type { AuthFetch } from "@/lib/auth";

describe("welcome api", () => {
  it("sends authenticated welcome activation events", async () => {
    const fetchImpl = vi
      .fn<AuthFetch>()
      .mockResolvedValue(Response.json({ status: "accepted" }, { status: 202 }));

    await sendWelcomeActivationEvent({ event: "action_clicked", action: "try_editor" }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("/api/signup/welcome-event", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "action_clicked", action: "try_editor" }),
    });
  });

  it("surfaces failed welcome activation telemetry writes", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(Response.json({}, { status: 503 }));

    await expect(sendWelcomeActivationEvent({ event: "viewed" }, fetchImpl)).rejects.toThrow(
      "Failed to record welcome activation event (503).",
    );
  });
});
