// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, settle, unmountAll } from "@/test/ui";
import { buttonNamed, control, typeInto } from "@/features/mail/settings/test-support";
import { LanguageRegionSection } from "./settings-language";
import { mockApi, renderWithClient } from "./settings-test-support";
import { timeZoneOptions } from "./time-zone-picker";
import { workingHoursFromDraft } from "./settings-working-hours";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const saved = {
  language: null,
  timeZone: "Europe/Paris",
  dateFormat: null,
  timeFormat: null,
  weekStart: null,
  workingHours: null,
  mail: { readingPane: "none", density: "default", conversationView: true },
  updatedAt: null,
};

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

async function renderSection() {
  const calls = mockApi({
    "/api/tools/account.preferences.get": saved,
    "/api/tools/account.preferences.set": (body) => ({ ...saved, ...(body as object) }),
  });
  renderWithClient(<LanguageRegionSection />);
  await settle();
  await settle();
  return calls;
}

const setCalls = (calls: ReturnType<typeof mockApi>) =>
  calls.filter((call) => call.path === "/api/tools/account.preferences.set").map((c) => c.body);

describe("Language & region", () => {
  it("offers only the languages Helix ships", async () => {
    await renderSection();
    const language = control<HTMLSelectElement>("Language");
    expect(Array.from(language?.options ?? []).map((option) => option.textContent)).toEqual([
      "English",
    ]);
    expect(language?.disabled).toBe(false);
    expect(document.querySelector("[title*='not available']")).toBeNull();
  });

  it("saves time format, date format and start of week as you choose them", async () => {
    const calls = await renderSection();
    const timeGroup = Array.from(document.querySelectorAll("fieldset")).find(
      (fieldset) => fieldset.querySelector("legend")?.textContent === "Time format",
    );
    const twentyFour = Array.from(timeGroup?.querySelectorAll("label") ?? []).find((label) =>
      label.textContent?.startsWith("24-hour"),
    );
    twentyFour?.querySelector("input")?.click();
    await settle();
    const week = control<HTMLSelectElement>("Start of week");
    act(() => {
      if (week === null) return;
      week.value = "1";
      week.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(setCalls(calls)).toEqual([{ timeFormat: "24h" }, { weekStart: 1 }]);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Start of week saved.");
  });

  it("finds a time zone by typing and saves it", async () => {
    const calls = await renderSection();
    const zone = control<HTMLInputElement>("Time zone");
    expect(zone?.getAttribute("role")).toBe("combobox");
    expect(zone?.value).toContain("Europe/Paris");
    typeInto(zone, "tokyo");
    expect(zone?.getAttribute("aria-expanded")).toBe("true");
    const option = document.querySelector('[role="option"]');
    expect(option?.textContent).toContain("Asia/Tokyo");
    act(() => {
      zone?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    expect(setCalls(calls)).toEqual([{ timeZone: "Asia/Tokyo" }]);
  });

  it("validates and saves working hours", async () => {
    const calls = await renderSection();
    control<HTMLInputElement>("Show my working hours")?.click();
    await settle();
    typeInto(control("Start"), "18:00");
    typeInto(control("End"), "09:00");
    buttonNamed("Save working hours")?.click();
    await settle();
    const alert = document.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toBe("Working hours must end after they start.");
    expect(control("Start")?.getAttribute("aria-describedby")).toBe(alert?.id);
    typeInto(control("End"), "19:30");
    control<HTMLInputElement>("Friday")?.click();
    buttonNamed("Save working hours")?.click();
    await settle();
    expect(setCalls(calls)).toEqual([
      {
        workingHours: {
          enabled: true,
          days: [1, 2, 3, 4].map((day) => ({ day, start: "18:00", end: "19:30" })),
        },
      },
    ]);
  });

  it("has no axe violations", async () => {
    await renderSection();
    expect(await axeViolations()).toEqual([]);
  });
});

describe("time zone options", () => {
  it("labels zones with their offset and sorts by it", () => {
    const options = timeZoneOptions(new Date(Date.UTC(2026, 0, 15)));
    const tokyo = options.find((option) => option.id === "Asia/Tokyo");
    expect(tokyo?.label).toBe("(GMT+09:00) Asia/Tokyo");
    expect(options.find((option) => option.id === "America/Los_Angeles")?.label).toBe(
      "(GMT-08:00) America/Los Angeles",
    );
    expect(options.indexOf(tokyo!)).toBeGreaterThan(
      options.findIndex((option) => option.id === "UTC"),
    );
  });

  it("shares one start and end time across the chosen days, in weekday order", () => {
    expect(
      workingHoursFromDraft({ enabled: true, days: [5, 1], start: "08:00", end: "16:00" }),
    ).toEqual({
      enabled: true,
      days: [
        { day: 1, start: "08:00", end: "16:00" },
        { day: 5, start: "08:00", end: "16:00" },
      ],
    });
  });
});
