// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountEmailFactorStatus } from "@helix/contracts";
import { axeViolations, settle, unmountAll } from "@/test/ui";
import { buttonNamed, control, typeInto } from "@/features/mail/settings/test-support";
import { EmailFactorSettings } from "./settings-email-factor";
import { mockApi, renderWithClient, sessionUser } from "./settings-test-support";

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});
const initial: AccountEmailFactorStatus = {
  outboundReady: true,
  email: null,
  verified: false,
  enabled: false,
  totpEnabled: false,
  pendingEmail: null,
};

describe("external email factor settings", () => {
  it("keeps setup unavailable when outbound mail is not working", async () => {
    mockApi({ "/api/account/email-mfa": { ...initial, outboundReady: false } });
    renderWithClient(<EmailFactorSettings />);
    await settle();
    await settle();
    expect(document.body.textContent).toContain("Outbound email must be configured and working");
    typeInto(control("External email address"), "me@gmail.com");
    typeInto(control("Confirm email settings with your password"), "password");
    expect(buttonNamed("Send verification code")?.disabled).toBe(true);
    expect(buttonNamed("Turn on email codes")).toBeNull();
  });

  it("verifies the external inbox before offering an explicit opt-in", async () => {
    let status = { ...initial };
    const calls = mockApi({
      "/api/account/email-mfa": () => status,
      "/api/auth/get-session": { user: sessionUser },
      "/api/account/email-mfa/verification": () => {
        status = { ...status, pendingEmail: "me@gmail.com" };
        return { sent: true };
      },
      "/api/account/email-mfa/verification/confirm": () => {
        status = { ...status, email: "me@gmail.com", verified: true, pendingEmail: null };
        return status;
      },
      "/api/account/email-mfa/enabled": () => {
        status = { ...status, enabled: true };
        return status;
      },
    });
    renderWithClient(<EmailFactorSettings />);
    await settle();
    await settle();
    typeInto(control("External email address"), "me@gmail.com");
    typeInto(control("Confirm email settings with your password"), "password");
    buttonNamed("Send verification code")?.click();
    await settle();
    await settle();
    expect(buttonNamed("Turn on email codes")).toBeNull();
    typeInto(control("External email verification code"), "123456");
    buttonNamed("Verify external email")?.click();
    await settle();
    await settle();
    expect(document.body.textContent).toContain("Verified external email: me@gmail.com");
    expect(document.body.textContent).toContain("Email codes are off.");
    typeInto(control("Confirm email settings with your password"), "password");
    buttonNamed("Turn on email codes")?.click();
    await settle();
    await settle();
    expect(calls.find((c) => c.path === "/api/account/email-mfa/enabled")?.body).toEqual({
      enabled: true,
      password: "password",
    });
    expect(buttonNamed("Turn off email codes")).not.toBeNull();
    expect(await axeViolations()).toEqual([]);
  });
});
