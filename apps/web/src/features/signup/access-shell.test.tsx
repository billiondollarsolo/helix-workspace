// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignupInviteShell } from "./invite-shell";
import { VerifyEmailShell } from "./verify-email-shell";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
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
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

describe("verify email shell", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("submits the token and shows verified state", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "active",
        org: {
          id: "11111111-1111-4111-8111-111111111111",
          slug: "acme",
          displayName: "Acme",
          status: "active",
          region: "default",
        },
        verification: { status: "verified" },
        session: { created: true, status: "created" },
        workspace: {
          workspaceUrl: "https://acme.helix.example/mail",
        },
      }),
    );

    await act(async () => {
      root.render(<VerifyEmailShell token="token-1" fetchImpl={fetchImpl} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Email verified");
    expect(container.textContent).toContain("Continue");
    expect(container.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe(
      "https://acme.helix.example/mail",
    );
    expect(fetchImpl).toHaveBeenCalledWith("/v1/api/signup/verify-email", expect.any(Object));
  });

  it("falls back to login after verification when no session cookie is created", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "active",
        org: {
          id: "11111111-1111-4111-8111-111111111111",
          slug: "acme",
          displayName: "Acme",
          status: "active",
          region: "default",
        },
        verification: { status: "verified" },
        session: { created: false, status: "credential_ready" },
        workspace: {
          workspaceUrl: "https://acme.helix.example/mail",
        },
      }),
    );

    await act(async () => {
      root.render(<VerifyEmailShell token="token-1" fetchImpl={fetchImpl} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Sign in with email/password");
    expect(container.textContent).toContain("ready for local email/password sign in");
    expect(container.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe("/login");
  });

  it("offers token-based resend when verification token is invalid or expired", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = urlForRequest(input);
      if (url === "/v1/api/signup/verify-email") {
        return Promise.resolve(
          Response.json(
            {
              error: {
                code: "signup_verification_invalid",
                message: "Signup email verification token is invalid or expired.",
              },
            },
            { status: 400 },
          ),
        );
      }
      if (url === "/v1/api/signup/resend-verification") {
        return Promise.resolve(Response.json({ status: "accepted" }, { status: 202 }));
      }
      return Promise.resolve(
        Response.json({ error: { message: `Unhandled ${url}` } }, { status: 500 }),
      );
    });

    await act(async () => {
      root.render(<VerifyEmailShell token="old-token" fetchImpl={fetchImpl} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Verification failed");
    expect(container.textContent).toContain("Send a new link");
    clickButton("Send a new link");
    await act(async () => {
      await Promise.resolve();
    });

    const resendCall = fetchImpl.mock.calls.find(
      ([input]) => urlForRequest(input) === "/v1/api/signup/resend-verification",
    );
    expect(resendCall?.[1]?.body).toBe(JSON.stringify({ token: "old-token" }));
    expect(container.textContent).toContain(
      "If this link can be refreshed, we will send a new verification email.",
    );
    expect(container.textContent).not.toContain("owner@example.com");
  });

  it("does not offer resend when verification token is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await act(async () => {
      root.render(<VerifyEmailShell token="" fetchImpl={fetchImpl} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("This verification link is missing its token.");
    expect(container.textContent).not.toContain("Send a new link");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries a transient verification failure without reloading the page", async () => {
    const successPayload = {
      status: "active",
      org: {
        id: "11111111-1111-4111-8111-111111111111",
        slug: "acme",
        displayName: "Acme",
        status: "active",
        region: "default",
      },
      verification: { status: "verified" },
      session: { created: true, status: "created" },
      workspace: {
        workspaceUrl: "https://acme.helix.example/mail",
      },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ error: { message: "Verification service unavailable." } }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json(successPayload));

    await act(async () => {
      root.render(<VerifyEmailShell token="token-1" fetchImpl={fetchImpl} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Try verification again");

    clickButton("Try verification again");
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Email verified");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("signup invite shell", () => {
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

  it("shows local email/password login before accepting an invite without a session", async () => {
    await act(async () => {
      root.render(
        <SignupInviteShell
          token="invite-token"
          getSession={() => Promise.resolve(null)}
          signIn={() =>
            Promise.resolve({
              id: "user-1",
              email: "ada@example.com",
              name: "Ada",
              actorId: "actor-1",
            })
          }
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Local email/password login");
    expect(container.textContent).toContain("Email + password");
    expect(container.querySelector('input[type="email"]')).not.toBeNull();
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
  });

  it("accepts an invite after local login succeeds", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      if (urlForRequest(input) === "/v1/api/signup/onboarding-invite/accept") {
        return Promise.resolve(
          Response.json({
            status: "accepted",
            org: {
              id: "11111111-1111-4111-8111-111111111111",
              slug: "acme",
              displayName: "Acme",
              status: "active",
              region: "default",
            },
            actorId: "actor-1",
            workspace: {
              workspaceUrl: "https://acme.helix.example/mail",
            },
          }),
        );
      }
      return Promise.resolve(
        Response.json({ error: { message: "Unhandled request" } }, { status: 500 }),
      );
    });

    await act(async () => {
      root.render(
        <SignupInviteShell
          token="invite-token"
          fetchImpl={fetchImpl}
          getSession={() => Promise.resolve(null)}
          signIn={() =>
            Promise.resolve({
              id: "user-1",
              email: "ada@example.com",
              name: "Ada",
              actorId: "actor-1",
            })
          }
        />,
      );
      await Promise.resolve();
    });

    const form = container.querySelector("form");
    if (form === null) {
      throw new Error("Local login form was not rendered.");
    }
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/v1/api/signup/onboarding-invite/accept",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "invite-token" }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(container.textContent).toContain("Invitation accepted");
    expect(container.textContent).toContain("Local email/password login remains available");
    expect(container.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe(
      "https://acme.helix.example/mail",
    );
  });

  it("retries invite acceptance after a transient backend failure", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ error: { message: "Invite service unavailable." } }, { status: 503 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          status: "accepted",
          org: {
            id: "11111111-1111-4111-8111-111111111111",
            slug: "acme",
            displayName: "Acme",
            status: "active",
            region: "default",
          },
          actorId: "actor-1",
          workspace: {
            workspaceUrl: "https://acme.helix.example/mail",
          },
        }),
      );

    await act(async () => {
      root.render(
        <SignupInviteShell
          token="invite-token"
          fetchImpl={fetchImpl}
          getSession={() =>
            Promise.resolve({
              id: "user-1",
              email: "ada@example.com",
              name: "Ada",
              actorId: "actor-1",
            })
          }
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Try joining again");

    clickButton("Try joining again");
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Invitation accepted");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

function clickButton(name: string): void {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.textContent?.includes(name),
  );
  if (button === undefined) {
    throw new Error(`Missing button: ${name}`);
  }
  act(() => {
    button.click();
  });
}

function urlForRequest(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}
