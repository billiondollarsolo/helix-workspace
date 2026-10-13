import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestSecondFactorStepUp,
  secondFactorStepUpReason,
  settleSecondFactorStepUp,
  stepUpRefusal,
  subscribeSecondFactorStepUp,
} from "./second-factor-step-up";

describe("second-factor step-up", () => {
  const unsubscribers: (() => void)[] = [];
  const mountPrompt = () => {
    const listener = vi.fn();
    unsubscribers.push(subscribeSecondFactorStepUp(listener));
    return listener;
  };

  afterEach(() => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    vi.useRealTimers();
  });

  it("recognises every refusal that a fresh verification resolves", async () => {
    const refusals = [
      { error: { code: "admin_mfa_required", message: "Verify to continue." } },
      { code: "crown_jewel_step_up_required", error: "Verify to continue." },
      { code: "step_up_required", error: "Verify to continue." },
    ];
    for (const body of refusals) {
      await expect(stepUpRefusal(Response.json(body, { status: 403 }))).resolves.toBe(
        "verification",
      );
    }
    await expect(
      stepUpRefusal(
        Response.json({ error: { code: "session_reauthentication_required" } }, { status: 401 }),
      ),
    ).resolves.toBe("reauthentication");
  });

  it("leaves other refusals alone and keeps the body readable", async () => {
    const forbidden = Response.json({ error: { code: "forbidden" } }, { status: 403 });
    await expect(stepUpRefusal(forbidden)).resolves.toBeNull();
    await expect(forbidden.json()).resolves.toEqual({ error: { code: "forbidden" } });
    for (const response of [
      Response.json({ code: "admin_mfa_required" }, { status: 200 }),
      Response.json({ error: { code: "admin_mfa_required" } }, { status: 401 }),
      Response.json({ error: { code: "unauthorized" } }, { status: 401 }),
      new Response("nope", { status: 403 }),
    ]) {
      await expect(stepUpRefusal(response)).resolves.toBeNull();
    }
  });

  it("returns the refusal when no prompt is mounted", async () => {
    await expect(requestSecondFactorStepUp("verification")).resolves.toBe(false);
    expect(secondFactorStepUpReason()).toBeNull();
  });

  it("shares one prompt between concurrent requests", async () => {
    const listener = mountPrompt();

    const first = requestSecondFactorStepUp("reauthentication");
    const second = requestSecondFactorStepUp("reauthentication", false);
    expect(secondFactorStepUpReason()).toBe("reauthentication");
    expect(listener).toHaveBeenCalledTimes(1);

    settleSecondFactorStepUp(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(secondFactorStepUpReason()).toBeNull();
  });

  it("answers waiting requests when the person cancels or the prompt goes away", async () => {
    mountPrompt();
    const cancelled = requestSecondFactorStepUp("verification");
    settleSecondFactorStepUp(false);
    await expect(cancelled).resolves.toBe(false);

    const abandoned = requestSecondFactorStepUp("verification");
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    await expect(abandoned).resolves.toBe(false);
  });

  it("does not reopen a dismissed prompt for background reads, only for actions", async () => {
    vi.useFakeTimers();
    mountPrompt();
    void requestSecondFactorStepUp("verification");
    settleSecondFactorStepUp(false);

    await expect(requestSecondFactorStepUp("verification", false)).resolves.toBe(false);
    expect(secondFactorStepUpReason()).toBeNull();

    // A session that must be verified again cannot be left waiting.
    void requestSecondFactorStepUp("reauthentication", false);
    expect(secondFactorStepUpReason()).toBe("reauthentication");
    settleSecondFactorStepUp(false);

    void requestSecondFactorStepUp("verification");
    expect(secondFactorStepUpReason()).toBe("verification");
    settleSecondFactorStepUp(false);

    vi.advanceTimersByTime(120_001);
    void requestSecondFactorStepUp("verification", false);
    expect(secondFactorStepUpReason()).toBe("verification");
    settleSecondFactorStepUp(true);
  });
});
