// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableTotp, listPasskeys } from "@/lib/auth";
import { axeViolations, settle, unmountAll } from "@/test/ui";
import { buttonNamed, control, typeInto } from "@/features/mail/settings/test-support";
import { passwordStrength } from "./settings-password";
import { SecuritySection } from "./settings-security";
import { sessionTitle } from "./settings-devices";
import { mockApi, renderWithClient } from "./settings-test-support";

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  listPasskeys: vi.fn(),
  enableTotp: vi.fn(),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const now = new Date().toISOString();
const sessions = [
  {
    id: "s-1",
    current: true,
    createdAt: now,
    lastActiveAt: now,
    expiresAt: now,
    ipAddress: "203.0.113.4",
    userAgent: null,
    browser: "Firefox",
    os: "macOS",
    deviceType: "desktop",
  },
  {
    id: "s-2",
    current: false,
    createdAt: now,
    lastActiveAt: now,
    expiresAt: now,
    ipAddress: null,
    userAgent: null,
    browser: "Safari",
    os: "iOS",
    deviceType: "mobile",
  },
];

beforeEach(() => {
  vi.mocked(listPasskeys).mockResolvedValue([]);
});

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

function routes(extra: Record<string, unknown> = {}) {
  return mockApi({
    "/api/account/sessions": { sessions },
    "/api/account/sessions/s-2/revoke": { revoked: true },
    "/api/account/sessions/revoke-others": { revoked: 1 },
    "/api/account/password": { changed: true },
    "/api/tools/account.preferences.get": {
      language: null,
      timeZone: "UTC",
      dateFormat: null,
      timeFormat: "24h",
      weekStart: null,
      workingHours: null,
      mail: { readingPane: "none", density: "default", conversationView: true },
      updatedAt: null,
    },
    ...extra,
  });
}

async function renderSection() {
  renderWithClient(<SecuritySection />);
  await settle();
  await settle();
}

describe("change password", () => {
  it("checks the confirmation, then changes the password and signs out other devices", async () => {
    const calls = routes();
    await renderSection();
    typeInto(control("Current password"), "old-password");
    typeInto(control("New password"), "a-much-longer-passphrase");
    typeInto(control("Confirm new password"), "something-else");
    expect(document.body.textContent).toContain("Strong password.");
    buttonNamed("Change password")?.click();
    await settle();
    const mismatch = document.querySelector<HTMLElement>('[role="alert"]');
    expect(mismatch?.textContent).toBe("Passwords don’t match.");
    expect(control("Confirm new password")?.getAttribute("aria-describedby")).toBe(mismatch?.id);

    typeInto(control("Confirm new password"), "a-much-longer-passphrase");
    expect(control<HTMLInputElement>("Sign out of other devices")?.checked).toBe(true);
    buttonNamed("Change password")?.click();
    await settle();
    expect(calls.find((call) => call.path === "/api/account/password")?.body).toEqual({
      currentPassword: "old-password",
      newPassword: "a-much-longer-passphrase",
      revokeOtherSessions: true,
    });
    expect(document.body.textContent).toContain(
      "Password changed. Your other devices were signed out.",
    );
    expect(control<HTMLInputElement>("Current password")?.value).toBe("");
  });

  it("ties the server's error to the current password field", async () => {
    routes({
      "/api/account/password": () =>
        Response.json(
          { error: { code: "bad_request", message: "Your current password is incorrect." } },
          { status: 400 },
        ),
    });
    await renderSection();
    typeInto(control("Current password"), "wrong");
    typeInto(control("New password"), "a-much-longer-passphrase");
    typeInto(control("Confirm new password"), "a-much-longer-passphrase");
    buttonNamed("Change password")?.click();
    await settle();
    const alert = document.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toBe("Your current password is incorrect.");
    expect(control("Current password")?.getAttribute("aria-describedby")).toBe(alert?.id);
  });

  it("rates password strength", () => {
    expect(passwordStrength("short")).toBe("too-short");
    expect(passwordStrength("abcdefgh")).toBe("weak");
    expect(passwordStrength("Abcdefg1")).toBe("fair");
    expect(passwordStrength("correct horse battery")).toBe("strong");
  });
});

describe("your devices", () => {
  it("lists devices with this device first and signs out another one", async () => {
    const calls = routes();
    await renderSection();
    const items = Array.from(document.querySelectorAll('[aria-label="Signed-in devices"] li'));
    expect(items.map((item) => item.querySelector("p")?.textContent)).toEqual([
      "Firefox on macOSThis device",
      "Safari on iOS",
    ]);
    expect(items[1]?.textContent).toContain("Last active Today");
    expect(buttonNamed("Sign out of Firefox on macOS")).toBeNull();
    buttonNamed("Sign out of Safari on iOS")?.click();
    await settle();
    expect(calls.some((call) => call.path === "/api/account/sessions/s-2/revoke")).toBe(true);
  });

  it("confirms before signing out every other device", async () => {
    const calls = routes();
    await renderSection();
    buttonNamed("Sign out of all other devices")?.click();
    await settle();
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("1 other device will need to sign in again.");
    expect(calls.some((call) => call.path === "/api/account/sessions/revoke-others")).toBe(false);
    buttonNamed("Sign out", dialog ?? document)?.click();
    await settle();
    expect(calls.some((call) => call.path === "/api/account/sessions/revoke-others")).toBe(true);
  });

  it("describes unknown devices honestly", () => {
    expect(sessionTitle({ ...sessions[0], browser: "Unknown", os: "" } as never)).toBe(
      "Unknown device",
    );
  });
});

describe("2-step verification", () => {
  it("labels the password and code inputs and reports failures as alerts", async () => {
    routes();
    vi.mocked(enableTotp)
      .mockRejectedValueOnce(new Error("Password is incorrect."))
      .mockResolvedValueOnce({ totpURI: "otpauth://totp/helix", backupCodes: [] });
    await renderSection();
    const password = control("Confirm with your current password");
    typeInto(password, "wrong");
    buttonNamed("Set up")?.click();
    await settle();
    const alert = Array.from(document.querySelectorAll('[role="alert"]')).find(
      (node) => node.textContent === "Password is incorrect.",
    );
    expect(alert).toBeDefined();
    expect(password?.getAttribute("aria-describedby")).toBe(alert?.id);

    buttonNamed("Set up")?.click();
    await settle();
    expect(control("6-digit code from your authenticator app")).not.toBeNull();
    expect(document.body.textContent).toContain("otpauth://totp/helix");
  });

  it("shows a passkey list failure instead of an empty list, and retries", async () => {
    routes();
    vi.mocked(listPasskeys)
      .mockRejectedValueOnce(new Error("Network unavailable."))
      .mockResolvedValueOnce([{ id: "pk-1", name: "Laptop" } as never]);
    await renderSection();
    expect(document.body.textContent).toContain(
      "Could not load your passkeys. Network unavailable.",
    );
    buttonNamed("Retry loading passkeys")?.click();
    await settle();
    expect(document.body.textContent).toContain("Laptop");
    expect(buttonNamed("Remove Laptop")).not.toBeNull();
  });

  it("has no axe violations", async () => {
    routes();
    await renderSection();
    expect(await axeViolations()).toEqual([]);
  });
});
