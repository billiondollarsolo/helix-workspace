// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionQueryKeys } from "@/lib/auth";
import { profileQueryKeys } from "@/lib/profile";
import { axeViolations, settle, unmountAll } from "@/test/ui";
import { PersonalInfoSection, ProfileHomeSection } from "./settings-profile";
import { mockApi, renderWithClient, sessionUser } from "./settings-test-support";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("Profile home and photo", () => {
  const profile = {
    actorId: sessionUser.actorId,
    orgId: "org-1",
    email: "morgan@example.com",
    displayName: "Morgan Lee",
    pronouns: "",
    jobTitle: "",
    about: "",
    avatarDataUrl: "data:image/jpeg;base64,/9j/4AAQ",
  };

  afterEach(() => {
    unmountAll();
    vi.restoreAllMocks();
  });

  it("welcomes you and links to each part of your account and app settings", async () => {
    mockApi({
      "/api/tools/account.preferences.get": {
        language: null,
        timeZone: "Asia/Tokyo",
        dateFormat: null,
        timeFormat: "24h",
        weekStart: null,
        workingHours: null,
        mail: { readingPane: "none", density: "default", conversationView: true },
        updatedAt: null,
      },
    });
    const onNavigate = vi.fn();
    renderWithClient(
      <ProfileHomeSection tab={undefined} onTabChange={vi.fn()} onNavigate={onNavigate} />,
      (client) => client.setQueryData(profileQueryKeys.current, profile),
    );
    await settle();
    await settle();
    expect(document.querySelector("h1")?.textContent).toBe("Welcome, Morgan Lee");
    expect(document.body.textContent).toContain("Asia/Tokyo · 24-hour clock");
    for (const [name, target] of [
      ["Security", "security"],
      ["Mail settings", "mail/general"],
      ["Calendar settings", "language"],
    ] as const) {
      Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.textContent?.includes(name))
        ?.click();
      expect(onNavigate).toHaveBeenLastCalledWith(target);
    }
    expect(await axeViolations()).toEqual([]);
  });

  it("removes the photo and rejects files that are not images", async () => {
    const calls = mockApi({
      "/api/profile": (body) => ({ profile: { ...profile, ...(body as object) } }),
    });
    renderWithClient(<PersonalInfoSection />, (client) =>
      client.setQueryData(profileQueryKeys.current, profile),
    );
    await settle();
    expect(document.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Profile photo of Morgan Lee",
    );
    const file = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(file?.labels?.[0]?.textContent).toBe("Change photo");
    expect(file?.accept).toBe("image/png,image/jpeg,image/webp");
    act(() => {
      Object.defineProperty(file, "files", {
        configurable: true,
        value: [new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })],
      });
      file?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Choose a PNG, JPEG or WebP image.",
    );

    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Remove photo")
      ?.click();
    await settle();
    expect(calls.find((call) => call.path === "/api/profile")?.body).toEqual({
      avatarDataUrl: null,
    });
    expect(file?.labels?.[0]?.textContent).toBe("Add photo");
    expect(await axeViolations()).toEqual([]);
  });
});

it("keeps a failed draft, saves profile fields, updates shared identity, and reopens saved values", async () => {
  const profile = {
    actorId: "actor-1",
    orgId: "org-1",
    email: "morgan@example.com",
    displayName: "Morgan Lee",
    pronouns: "",
    jobTitle: "",
    about: "",
    avatarDataUrl: null,
  };
  const updated = {
    ...profile,
    displayName: "Morgan Rivera",
    pronouns: "they/them",
    jobTitle: "Designer",
    about: "Building Helix",
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(profileQueryKeys.current, profile);
  client.setQueryData(sessionQueryKeys.current, {
    id: "login-1",
    email: profile.email,
    name: profile.displayName,
    actorId: profile.actorId,
  });
  document.cookie = `helix_csrf=${"p".repeat(43)}; Path=/`;
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json({ error: { message: "Could not save. Please try again." } }, { status: 503 }),
    )
    .mockResolvedValueOnce(Response.json({ profile: updated }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = () =>
    root.render(
      <QueryClientProvider client={client}>
        <PersonalInfoSection />
      </QueryClientProvider>,
    );
  try {
    act(render);
    for (const name of ["displayName", "pronouns", "jobTitle", "about"] as const) {
      const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[name="${name}"]`,
      )!;
      const prototype =
        name === "about" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      act(() => {
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, updated[name]);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    const submit = () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await act(async () => {
      submit();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Please try again");
    expect(container.querySelector<HTMLInputElement>('[name="displayName"]')?.value).toBe(
      updated.displayName,
    );
    expect(client.getQueryData(sessionQueryKeys.current)).toMatchObject({
      name: profile.displayName,
    });
    await act(async () => {
      submit();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Profile saved.");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/v1/api/profile");
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        displayName: updated.displayName,
        pronouns: updated.pronouns,
        jobTitle: updated.jobTitle,
        about: updated.about,
      }),
    );
    expect(client.getQueryData(sessionQueryKeys.current)).toMatchObject({
      name: updated.displayName,
      actorId: profile.actorId,
    });
    expect(client.getQueryData(profileQueryKeys.current)).toEqual(updated);
    act(() => root.render(null));
    act(render);
    for (const name of ["displayName", "pronouns", "jobTitle", "about"] as const) {
      expect(container.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value).toBe(
        updated[name],
      );
    }
  } finally {
    act(() => root.unmount());
    container.remove();
    client.clear();
    document.cookie = "helix_csrf=; Max-Age=0; Path=/";
    vi.restoreAllMocks();
  }
});
