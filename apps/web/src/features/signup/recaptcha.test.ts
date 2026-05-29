// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleSignupRecaptchaExecutor } from "./recaptcha";

describe("GoogleSignupRecaptchaExecutor", () => {
  afterEach(() => {
    window.grecaptcha = undefined;
    vi.restoreAllMocks();
  });

  it("executes the configured signup action through grecaptcha", async () => {
    const execute = vi.fn().mockResolvedValue("captcha-token");
    window.grecaptcha = {
      ready(callback) {
        callback();
      },
      execute,
    };

    const executor = new GoogleSignupRecaptchaExecutor({ siteKey: "site-key" });

    await expect(executor.execute()).resolves.toBe("captcha-token");
    expect(execute).toHaveBeenCalledWith("site-key", { action: "signup" });
  });

  it("fails when grecaptcha is not loaded", async () => {
    const executor = new GoogleSignupRecaptchaExecutor({ siteKey: "site-key" });

    await expect(executor.execute()).rejects.toThrow("Signup abuse verification is unavailable.");
  });
});
