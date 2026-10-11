// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, settle, unmountAll } from "@/test/ui";
import { buttonNamed, control, typeInto } from "@/features/mail/settings/test-support";
import { grantablePurposes, setupHints } from "./app-password-purposes";
import { AppPasswordsSection } from "./settings-app-passwords";
import { mockApi, renderWithClient } from "./settings-test-support";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const existing = {
  id: "pw-1",
  label: "Old laptop",
  scopes: ["drive.read", "drive.write"],
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  createdAt: "2026-09-01T10:00:00.000Z",
};

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

async function renderSection(
  grantableScopes = ["mail.send", "calendar.read", "drive.read", "drive.write"],
) {
  const calls = mockApi({
    "/api/tools/app.passwords.list": { appPasswords: [existing], grantableScopes },
    "/api/tools/app.passwords.create": (body) => ({
      appPassword: {
        ...existing,
        id: "pw-2",
        ...(body as object),
        createdAt: new Date().toISOString(),
      },
      password: "abcd-efgh-ijkl-mnop",
    }),
    "/api/tools/app.passwords.revoke": { status: "revoked" },
    "/api/tools/account.preferences.get": {
      language: null,
      timeZone: "UTC",
      dateFormat: "mdy",
      timeFormat: "12h",
      weekStart: null,
      workingHours: null,
      mail: { readingPane: "none", density: "default", conversationView: true },
      updatedAt: null,
    },
  });
  renderWithClient(<AppPasswordsSection />);
  await settle();
  await settle();
  return calls;
}

describe("App passwords", () => {
  it("offers only what you can grant, and requires a name and a use", async () => {
    const calls = await renderSection(["calendar.read", "caldav"]);
    const uses = Array.from(document.querySelectorAll("fieldset fieldset label")).map(
      (label) => label.textContent,
    );
    expect(uses).toEqual(["Sync your calendar (CalDAV)"]);
    expect(calls.find((call) => call.path === "/api/tools/app.passwords.list")?.body).toEqual({
      actorId: "00000000-0000-4000-8000-0000000000a1",
      includeRevoked: false,
    });
    buttonNamed("Create password")?.click();
    await settle();
    const alert = document.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toBe("Name the app or device that will use this password.");
    expect(control("App or device name")?.getAttribute("aria-describedby")).toBe(alert?.id);
  });

  it("creates a password, shows it once with a copy button and setup details", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const calls = await renderSection();
    typeInto(control("App or device name"), "Phone mail");
    control<HTMLInputElement>("Send mail from a mail app (SMTP)")?.click();
    buttonNamed("Create password")?.click();
    await settle();
    await settle();
    expect(calls.find((call) => call.path === "/api/tools/app.passwords.create")?.body).toEqual({
      label: "Phone mail",
      scopes: ["mail.send"],
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("abcd-efgh-ijkl-mnop");
    expect(dialog?.textContent).toContain("morgan@example.com");
    expect(dialog?.textContent).toContain("port 465 with SSL/TLS");
    expect(dialog?.textContent).not.toMatch(/IMAP/u);
    buttonNamed("Copy", dialog ?? document)?.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith("abcd-efgh-ijkl-mnop");
    expect(dialog?.textContent).toContain("Copied");
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("lists passwords with when they were used and revokes after confirming", async () => {
    const calls = await renderSection();
    const row = document.querySelector('[aria-label="App passwords"] li');
    expect(row?.textContent).toContain("Old laptop");
    expect(row?.textContent).toContain("WebDAV");
    expect(row?.textContent).toContain("Created Sep 1, 2026");
    expect(row?.textContent).toContain("Never used");
    buttonNamed("Revoke Old laptop")?.click();
    await settle();
    const confirm = document.querySelector('[role="alertdialog"]');
    expect(confirm?.textContent).toContain("Revoke “Old laptop”?");
    expect(calls.some((call) => call.path === "/api/tools/app.passwords.revoke")).toBe(false);
    buttonNamed("Revoke", confirm ?? document)?.click();
    await settle();
    expect(calls.find((call) => call.path === "/api/tools/app.passwords.revoke")?.body).toEqual({
      passwordId: "pw-1",
    });
  });

  it("explains when nothing can be granted", async () => {
    await renderSection([]);
    expect(document.body.textContent).toContain(
      "Your account doesn’t have access to any app that signs in with an app password.",
    );
  });
});

describe("app password purposes", () => {
  it("keeps only held scopes and points each protocol at its server", () => {
    const purposes = grantablePurposes(["calendar.read", "webdav", "admin.users"]);
    expect(purposes.map((purpose) => [purpose.id, purpose.scopes])).toEqual([
      ["calendar", ["calendar.read"]],
      ["files", ["webdav"]],
    ]);
    expect(setupHints(purposes, "https://helix.example").map((hint) => hint.server)).toEqual([
      "https://helix.example/v1/dav/cal/",
      "https://helix.example/v1/dav/files/",
    ]);
  });
});
