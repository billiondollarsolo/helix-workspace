import { describe, expect, it, vi } from "vitest";
import { GoogleRecaptchaVerifier } from "./recaptcha.js";

describe("GoogleRecaptchaVerifier", () => {
  it("requires a token before contacting the provider", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const verifier = new GoogleRecaptchaVerifier({ secret: "secret", fetchImpl });

    await expect(verifier.verify({ token: undefined, ip: "203.0.113.10" })).resolves.toEqual({
      allowed: false,
      reason: "missing_token",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts successful signup action responses above the score threshold", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ success: true, score: 0.9, action: "signup" }));
    const verifier = new GoogleRecaptchaVerifier({
      secret: "secret",
      fetchImpl,
      endpoint: "https://recaptcha.test/siteverify",
      minScore: 0.7,
    });

    await expect(verifier.verify({ token: "token-1", ip: "203.0.113.10" })).resolves.toEqual({
      allowed: true,
      score: 0.9,
      action: "signup",
    });
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://recaptcha.test/siteverify");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    const body = init?.body as URLSearchParams;
    expect(body.get("response")).toBe("token-1");
    expect(body.get("remoteip")).toBe("203.0.113.10");
    expect(body.get("secret")).toBe("secret");
  });

  it("rejects low scores and wrong actions", async () => {
    const lowScoreVerifier = new GoogleRecaptchaVerifier({
      secret: "secret",
      minScore: 0.7,
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ success: true, score: 0.3, action: "signup" })),
    });
    await expect(lowScoreVerifier.verify({ token: "token", ip: "203.0.113.10" })).resolves.toEqual({
      allowed: false,
      reason: "low_score",
      score: 0.3,
      action: "signup",
    });

    const wrongActionVerifier = new GoogleRecaptchaVerifier({
      secret: "secret",
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ success: true, score: 0.9, action: "login" })),
    });
    await expect(
      wrongActionVerifier.verify({ token: "token", ip: "203.0.113.10" }),
    ).resolves.toEqual({
      allowed: false,
      reason: "invalid_token",
      action: "login",
    });
  });
});
