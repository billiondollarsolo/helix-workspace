// @vitest-environment jsdom

import type { AccountPreferences } from "@helix/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSettingsSectionId, settingsSectionBase } from "@/components/shell/overlay-context";
import { axeViolations, click, key, settle, unmountAll } from "@/test/ui";
import type { MailUserSettings, MailVacationSettings } from "../api";
import { MailSettingsSection, type MailSettingsTab } from "./index";
import { buttonNamed, control, renderSettings, typeInto, waitFor } from "./test-support";

const api = vi.hoisted(() => ({
  getMailUserSettings: vi.fn(),
  setMailUserSettings: vi.fn(),
  getMailVacation: vi.fn(),
  setMailVacation: vi.fn(),
  listMailLabels: vi.fn(),
  listMailFilters: vi.fn(),
}));
const account = vi.hoisted(() => ({
  getAccountPreferences: vi.fn(),
  setAccountPreferences: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  ...api,
}));
vi.mock("@/features/account/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/account/api")>()),
  ...account,
}));

const preferences: AccountPreferences = {
  language: "de",
  timeZone: "Europe/Berlin",
  dateFormat: null,
  timeFormat: null,
  weekStart: null,
  workingHours: null,
  mail: { readingPane: "none", density: "default", conversationView: true },
  updatedAt: null,
};

const settings: MailUserSettings = {
  signatureText: "Thanks, Morgan",
  signatureHtml: "<b>Thanks</b>",
  includeSignatureOnReplies: true,
  blockedSenders: ["spam@example.net"],
  updatedAt: null,
};

beforeEach(() => {
  account.getAccountPreferences.mockResolvedValue(preferences);
  account.setAccountPreferences.mockImplementation(
    (input: { mail: Partial<AccountPreferences["mail"]> }) =>
      Promise.resolve({ ...preferences, mail: { ...preferences.mail, ...input.mail } }),
  );
  api.getMailUserSettings.mockResolvedValue(settings);
  api.setMailUserSettings.mockImplementation((input: Partial<MailUserSettings>) =>
    Promise.resolve({ ...settings, ...input }),
  );
  api.getMailVacation.mockResolvedValue(null);
  api.setMailVacation.mockImplementation((input: MailVacationSettings) => Promise.resolve(input));
  api.listMailLabels.mockResolvedValue([]);
  api.listMailFilters.mockResolvedValue([]);
});

afterEach(() => {
  unmountAll();
  vi.clearAllMocks();
});

function renderGeneral(openSettings = vi.fn()) {
  const onTabChange = vi.fn();
  const view = renderSettings(<MailSettingsSection tab="general" onTabChange={onTabChange} />, {
    openSettings,
  });
  return { ...view, onTabChange };
}

function radio(name: string): HTMLInputElement | null {
  return control(name);
}

describe("Mail settings tabs", () => {
  it("opens the tab from the deep link and falls back to General", () => {
    const selected = () =>
      document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? "";
    const filters = renderSettings(
      <MailSettingsSection tab="filters" onTabChange={() => undefined} />,
    );
    expect(selected()).toBe("Filters and blocked addresses");
    filters.unmount();
    renderSettings(<MailSettingsSection tab="nonsense" onTabChange={() => undefined} />);
    expect(selected()).toBe("General");
  });

  it("moves between tabs with the arrow keys", async () => {
    const tabs: MailSettingsTab[] = [];
    renderSettings(<MailSettingsSection tab="general" onTabChange={(tab) => tabs.push(tab)} />);
    const general = document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    general?.focus();
    await key("ArrowRight");
    await key("ArrowLeft");
    await key("End");
    expect(tabs).toEqual(["labels", "filters", "filters"]);
    expect(general?.getAttribute("aria-controls")).toBe("mail-settings-panel");
  });

  it("accepts mail/<tab> settings ids", () => {
    expect(isSettingsSectionId("mail")).toBe(true);
    expect(isSettingsSectionId("mail/filters")).toBe(true);
    expect(isSettingsSectionId("mail/filters/extra")).toBe(false);
    expect(isSettingsSectionId("mail/../profile")).toBe(false);
    expect(isSettingsSectionId("signature")).toBe(false);
    expect(isSettingsSectionId("bots/11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isSettingsSectionId("bots/invalid")).toBe(false);
    expect(isSettingsSectionId("bots/11111111-1111-4111-8111-111111111111/extra")).toBe(false);
    expect(settingsSectionBase("mail/labels")).toBe("mail");
  });
});

describe("General", () => {
  it("shows account language and time zone with a link to change them", async () => {
    const openSettings = vi.fn();
    renderGeneral(openSettings);
    await waitFor(
      () => (document.body.textContent?.includes("Europe/Berlin") ? true : null),
      "prefs",
    );
    expect(document.body.textContent).toContain("Deutsch");
    click(buttonNamed("Change in Language & region"));
    expect(openSettings).toHaveBeenCalledWith("language");
    await waitFor(() => control("Signature"), "signature");
    await waitFor(() => radio("Vacation responder off"), "vacation");
    expect(await axeViolations()).toEqual([]);
  });

  it("saves reading pane, density and conversation view as they change", async () => {
    renderGeneral();
    await waitFor(() => radio("Right of inbox"), "reading pane");
    click(radio("Right of inbox"));
    await settle();
    expect(account.setAccountPreferences).toHaveBeenLastCalledWith({
      mail: { readingPane: "right" },
    });
    expect(radio("Right of inbox")?.checked).toBe(true);

    click(radio("Compact"));
    await settle();
    expect(account.setAccountPreferences).toHaveBeenLastCalledWith({
      mail: { density: "compact" },
    });

    click(radio("Conversation view off"));
    await settle();
    expect(account.setAccountPreferences).toHaveBeenLastCalledWith({
      mail: { conversationView: false },
    });
  });

  it("puts a failed preference back", async () => {
    account.setAccountPreferences.mockRejectedValue(new Error("Preferences are read-only."));
    renderGeneral();
    await waitFor(() => radio("Below inbox"), "reading pane");
    click(radio("Below inbox"));
    await settle();
    await settle();
    expect(radio("No split")?.checked).toBe(true);
  });

  it("saves only the signature fields", async () => {
    renderGeneral();
    const signature = await waitFor(() => control<HTMLTextAreaElement>("Signature"), "signature");
    expect(signature.value).toBe("Thanks, Morgan");
    typeInto(signature, "Best, Morgan");
    click(control("Add this signature to replies"));
    click(buttonNamed("Save signature"));
    await waitFor(
      () => (document.body.textContent?.includes("Signature saved.") ? true : null),
      "saved",
    );
    expect(api.setMailUserSettings).toHaveBeenCalledWith({
      signatureText: "Best, Morgan",
      includeSignatureOnReplies: false,
    });
  });
});

describe("Vacation responder", () => {
  it("validates before turning on, then saves whole days", async () => {
    renderGeneral();
    await waitFor(() => radio("Vacation responder on"), "vacation");
    expect(control("Subject")?.disabled).toBe(true);
    click(radio("Vacation responder on"));
    expect(control("Subject")?.disabled).toBe(false);

    click(buttonNamed("Save responder"));
    await settle();
    const subject = control("Subject");
    expect(subject?.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(subject?.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("Add a subject.");
    expect(control("Message")?.getAttribute("aria-invalid")).toBe("true");
    expect(api.setMailVacation).not.toHaveBeenCalled();

    typeInto(control("First day"), "2026-12-21");
    click(control("Turn off after"));
    typeInto(control("Last day"), "2026-12-20");
    typeInto(control("Subject"), "Away for the holidays");
    typeInto(control<HTMLTextAreaElement>("Message"), "Back on January 4.");
    click(buttonNamed("Save responder"));
    await settle();
    expect(control("Last day")?.getAttribute("aria-invalid")).toBe("true");

    typeInto(control("Last day"), "2027-01-03");
    click(buttonNamed("Save responder"));
    await waitFor(
      () => (document.body.textContent?.includes("Vacation responder is on.") ? true : null),
      "saved",
    );
    expect(api.setMailVacation).toHaveBeenCalledWith({
      enabled: true,
      subject: "Away for the holidays",
      body: "Back on January 4.",
      startsAt: new Date(2026, 11, 21).toISOString(),
      endsAt: new Date(new Date(2027, 0, 4).getTime() - 1).toISOString(),
    });
  });

  it("turns off without needing the other fields", async () => {
    api.getMailVacation.mockResolvedValue({
      enabled: true,
      subject: "",
      body: "",
      startsAt: null,
      endsAt: null,
    } satisfies MailVacationSettings);
    renderGeneral();
    await waitFor(() => radio("Vacation responder off"), "vacation");
    expect(radio("Vacation responder on")?.checked).toBe(true);
    click(radio("Vacation responder off"));
    click(buttonNamed("Save responder"));
    await waitFor(
      () => (document.body.textContent?.includes("Vacation responder is off.") ? true : null),
      "saved",
    );
    expect(api.setMailVacation).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
});
