// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { sessionQueryKeys } from "@/lib/auth";
import { profileQueryKeys } from "@/lib/profile";
import { ProfileSection } from "./settings-account";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

it("keeps a failed draft, saves profile fields, updates shared identity, and reopens saved values", async () => {
  const profile = {
    actorId: "actor-1",
    orgId: "org-1",
    email: "morgan@example.com",
    displayName: "Morgan Lee",
    pronouns: "",
    jobTitle: "",
    about: "",
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
        <ProfileSection />
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
