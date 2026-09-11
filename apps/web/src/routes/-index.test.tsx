// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingPage, redirectSignedInRoot } from "./-landing-page";

vi.mock("@tanstack/react-router", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return {
    ...actual,
    Link: ({
      to,
      children,
      ...props
    }: {
      readonly to: string;
      readonly children: ReactNode;
      readonly className?: string;
    }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
    redirect: (options: unknown) => ({ redirected: true, options }),
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

describe("root landing route", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("shows the login entry point without public signup", () => {
    act(() => {
      root.render(<LandingPage />);
    });

    expect(container.textContent).toContain("Helix");
    expect(container.querySelector('a[href="/signup"]')).toBeNull();
    expect(linkNamed("Sign in")?.getAttribute("href")).toBe("/login");
  });

  it("leaves anonymous visitors on the landing page", async () => {
    await expect(redirectSignedInRoot(() => Promise.resolve(null))).resolves.toBeUndefined();
  });

  it("redirects signed-in users into the app", async () => {
    await expect(
      redirectSignedInRoot(() =>
        Promise.resolve({
          id: "user-1",
          email: "owner@example.com",
          name: "Owner",
          actorId: "actor-1",
        }),
      ),
    ).rejects.toMatchObject({
      redirected: true,
      options: { to: "/mail", search: {} },
    });
  });
});

function linkNamed(name: string): HTMLAnchorElement | null {
  return (
    [...container.querySelectorAll<HTMLAnchorElement>("a")].find(
      (link) => link.textContent?.includes(name) === true,
    ) ?? null
  );
}
