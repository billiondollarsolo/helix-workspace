// @vitest-environment jsdom

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { signOut } from "@/lib/auth";
import { ProfileMenu } from "./profile-menu";

const { navigate, invalidate, clear } = vi.hoisted(() => ({
  navigate: vi.fn(),
  invalidate: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate, invalidate }),
  Link: ({
    to,
    children,
    ...props
  }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
  useQueryClient: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  sessionUserQueryOptions: () => ({ queryKey: ["session-user"] }),
  signOut: vi.fn(() => Promise.resolve()),
}));

describe("ProfileMenu", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(useQuery).mockReturnValue({
      data: { name: "Mira Chen", email: "mira@helix.test" },
    } as never);
    vi.mocked(useQueryClient).mockReturnValue({ clear } as never);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function openCard(openSettings = vi.fn()) {
    act(() => root.render(<ProfileMenu openSettings={openSettings} />));
    const trigger = container.querySelector<HTMLButtonElement>("button");
    expect(trigger?.getAttribute("aria-label")).toBe("Account: Mira Chen");
    act(() => trigger?.click());
    const card = document.querySelector<HTMLElement>('[role="dialog"]');
    if (card === null) throw new Error("Account card did not open");
    return { card, openSettings };
  }

  function buttonIn(card: HTMLElement, label: string): HTMLButtonElement | undefined {
    return Array.from(card.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === label,
    );
  }

  it("shows the account card with avatar, name and email", () => {
    const { card } = openCard();
    expect(card.getAttribute("aria-label")).toBe("Account");
    expect(card.textContent).toContain("Mira Chen");
    expect(card.textContent).toContain("mira@helix.test");
    expect(card.textContent).not.toContain("Accent");
  });

  it("manages the account in settings", () => {
    const { card, openSettings } = openCard();
    act(() => buttonIn(card, "Manage your account and status")?.click());
    expect(openSettings).toHaveBeenCalledWith("profile");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("offers the Admin console only to admins", () => {
    const { card } = openCard();
    expect(card.textContent).not.toContain("Admin console");
    act(() => root.unmount());
    root = createRoot(container);

    vi.mocked(useQuery).mockReturnValue({
      data: {
        name: "Mira Chen",
        email: "mira@helix.test",
        scopes: ["mail.read", "admin.users.read"],
      },
    } as never);
    const { card: adminCard } = openCard();
    const link = Array.from(adminCard.querySelectorAll("a")).find(
      (anchor) => anchor.textContent?.trim() === "Admin console",
    );
    expect(link?.getAttribute("href")).toBe("/admin");
    act(() => link?.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("signs out, clears cached data and returns to login", async () => {
    const { card } = openCard();
    await act(async () => {
      buttonIn(card, "Sign out")?.click();
      await Promise.resolve();
    });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({ to: "/login" });
  });
});
